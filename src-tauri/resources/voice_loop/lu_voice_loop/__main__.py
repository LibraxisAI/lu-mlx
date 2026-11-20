"""Entry point: python -m lu_voice_loop --port <n> --models-dir <dir>

Environment:
  LU_VOICE_TOKEN             required, the launch secret (never on the command line)
  LU_VOICE_ALLOWED_ORIGINS   optional, comma separated webview origins

Stdout carries one JSON object per line for the app:
  {"event": "listening", "port": 47720}
  {"event": "ready"}
  {"event": "fatal", "code": "model_missing", "message": "..."}
Stderr carries the redacted log.

The process ends on SIGTERM, on SIGINT and when stdin closes. The app keeps
the write end of stdin open, so the loop goes away with the app even if the
app is killed. Windows has no SIGTERM, there stdin is the graceful path.
"""

import argparse
import asyncio
import errno
import json
import os
import socket
import sys
import threading
from pathlib import Path

from .errors import (
    EXIT_MODEL_LOAD,
    EXIT_PORT_IN_USE,
    EXIT_USAGE,
    FatalStartupError,
    os_error_text,
)

HOST = "127.0.0.1"

# After a shutdown request the process is given this long to unwind. A model
# load or an inference thread cannot be interrupted and could keep the
# interpreter alive, so a timer ends the process for good.
HARD_EXIT_SECS = 8.0


def emit(event: str, **fields) -> None:
    sys.stdout.write(json.dumps({"event": event, **fields}) + "\n")
    sys.stdout.flush()


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="lu_voice_loop", description="Locally Uncensored voice loop sidecar")
    parser.add_argument("--port", type=int, required=True, help="loopback port, 0 picks a free one")
    parser.add_argument("--models-dir", type=Path, required=True, help="directory the voice models were installed to")
    parser.add_argument("--verify-models", action="store_true", help="check every model checksum, then exit")
    parser.add_argument("--no-stdin-watch", action="store_true", help="keep running after stdin closes")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    return args


def bind_loopback(port: int) -> socket.socket:
    """Bind before anything slow happens so a busy port fails at once."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if os.name != "nt":
        # On Windows this option would let a second process share the port.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((HOST, port))
    except OSError as e:
        sock.close()
        if e.errno in (errno.EADDRINUSE, errno.EACCES) or getattr(e, "winerror", None) in (10048, 10013):
            raise FatalStartupError(
                EXIT_PORT_IN_USE, "port_in_use",
                "Port %d on 127.0.0.1 is already in use. Close the other program or restart the app." % port,
            ) from e
        raise FatalStartupError(
            EXIT_PORT_IN_USE, "bind_failed", "Could not open port %d on 127.0.0.1: %s." % (port, os_error_text(e)),
        ) from e
    sock.set_inheritable(False)
    # Listen here and not only when uvicorn starts serving: the "listening"
    # event goes out before that, and a bound socket that does not listen yet
    # refuses a client that connects right away. uvicorn calls listen again
    # with its own backlog, which is allowed.
    sock.listen()
    return sock


def _wait_for_pipe_close_windows() -> bool:
    """Poll the stdin pipe until its write end is gone. False if stdin is no pipe.

    A blocking read is not an option on Windows: while one thread sits in
    ReadFile on the stdin handle, every DLL that initialises its own C runtime
    touches the same handle and waits for that read, so the model libraries
    never finish loading.
    """
    import ctypes
    import msvcrt
    import time
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetFileType.argtypes = [wintypes.HANDLE]
    kernel32.PeekNamedPipe.argtypes = [
        wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
        wintypes.LPDWORD, wintypes.LPDWORD, wintypes.LPDWORD,
    ]
    file_type_pipe = 3
    try:
        handle = msvcrt.get_osfhandle(sys.stdin.fileno())
    except (OSError, ValueError, AttributeError):
        return False
    if kernel32.GetFileType(handle) != file_type_pipe:
        return False
    available = wintypes.DWORD(0)
    while kernel32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
        if available.value:
            # Bytes that are already there are taken without blocking.
            os.read(sys.stdin.fileno(), min(available.value, 4096))
            continue
        time.sleep(0.2)
    return True


def watch_stdin(on_closed) -> None:
    def run():
        if sys.platform == "win32":
            if not _wait_for_pipe_close_windows():
                # A console or NUL: nothing to watch, the app always passes a pipe.
                return
        else:
            try:
                while sys.stdin.buffer.read(4096):
                    pass
            except (OSError, ValueError):
                pass
        try:
            on_closed()
        except RuntimeError:
            # The loop is already gone, the process is on its way out.
            pass

    threading.Thread(target=run, name="stdin-watch", daemon=True).start()


async def serve(args: argparse.Namespace, token: str, origins: tuple[str, ...], manifest) -> int:
    import uvicorn

    from .engines import load_engines
    from .server import VoiceServer

    sock = bind_loopback(args.port)
    port = sock.getsockname()[1]
    voice = VoiceServer(token=token, origins=origins, port=port)
    loop = asyncio.get_running_loop()
    exit_code = 0
    stopping = False

    def request_stop() -> None:
        nonlocal stopping
        if stopping:
            return
        stopping = True
        timer = threading.Timer(HARD_EXIT_SECS, lambda: os._exit(exit_code))
        timer.daemon = True
        timer.start()
        server.should_exit = True
        loop.create_task(voice.shutdown())

    class Server(uvicorn.Server):
        def handle_exit(self, sig, frame):
            # Not passed on to uvicorn: it would raise the signal again after
            # shutdown and turn a clean stop into a signal exit code.
            loop.call_soon_threadsafe(request_stop)

    server = Server(uvicorn.Config(
        voice.app,
        # The access log would print the ticket in the WebSocket URL.
        access_log=False,
        log_config=None,
        log_level="warning",
        lifespan="off",
        ws_max_size=2 * 1024 * 1024,
        timeout_graceful_shutdown=2,
    ))

    def on_loaded(engines, error: BaseException | None) -> None:
        nonlocal exit_code
        if stopping:
            return
        if error is None:
            voice.set_engines(engines)
            emit("ready")
            return
        voice.set_failed()
        exit_code = EXIT_MODEL_LOAD
        message = "The voice models could not be loaded: %s." % os_error_text(error)
        emit("fatal", code="model_load_failed", message=message)
        print(message, file=sys.stderr, flush=True)
        request_stop()

    def load() -> None:
        # A daemon thread and not the loop's executor: the loop would wait for
        # an executor thread on shutdown, and a model load cannot be interrupted.
        try:
            engines, error = load_engines(args.models_dir, manifest), None
        except BaseException as e:
            engines, error = None, e
        try:
            loop.call_soon_threadsafe(on_loaded, engines, error)
        except RuntimeError:
            pass

    if not args.no_stdin_watch:
        watch_stdin(lambda: loop.call_soon_threadsafe(request_stop))

    emit("listening", port=port)
    threading.Thread(target=load, name="model-load", daemon=True).start()
    try:
        await server.serve(sockets=[sock])
    finally:
        await voice.shutdown()
    return exit_code


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)

    from .log import setup_logging
    from .models import check_installed, load_manifest

    setup_logging()
    try:
        manifest = load_manifest()
        if args.verify_models:
            check_installed(args.models_dir, manifest, verify_hashes=True)
            emit("verified")
            return 0

        from .auth import read_allowed_origins, read_launch_token

        try:
            token = read_launch_token()
            origins = read_allowed_origins()
        except ValueError as e:
            raise FatalStartupError(EXIT_USAGE, "bad_environment", str(e)) from e
        check_installed(args.models_dir, manifest)

        return asyncio.run(serve(args, token, origins, manifest))
    except FatalStartupError as e:
        emit("fatal", code=e.code, message=e.message)
        print(e.message, file=sys.stderr, flush=True)
        return e.exit_code
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    sys.stderr.flush()
    # Not sys.exit: the stdin watcher is blocked in a read, and interpreter
    # shutdown aborts when a daemon thread holds the stdin lock.
    os._exit(code)
