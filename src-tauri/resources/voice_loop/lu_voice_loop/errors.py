"""Startup failures the app shows to the user. Always English."""

EXIT_USAGE = 2
EXIT_MODEL_MISSING = 3
EXIT_PORT_IN_USE = 4
EXIT_MODEL_LOAD = 5


class FatalStartupError(Exception):
    """A failure that ends the process with a stable code and a clear message."""

    def __init__(self, exit_code: int, code: str, message: str):
        super().__init__(message)
        self.exit_code = exit_code
        self.code = code
        self.message = message


def os_error_text(e: BaseException) -> str:
    """One exception, in English.

    An OSError carries the operating system's own sentence, which is localized
    on a non-English Windows. The number means the same in every language, so
    the wording is dropped and the number kept (same rule as whisper_server.py).
    """
    if isinstance(e, OSError):
        code = getattr(e, "winerror", None) or e.errno
        if code is None:
            return type(e).__name__
        return "%s (os error %s)" % (type(e).__name__, code)
    return "%s: %s" % (type(e).__name__, e)
