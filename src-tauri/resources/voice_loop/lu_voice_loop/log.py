"""Logging that cannot leak audio, transcripts, tool data or tokens.

Pipecat and its dependencies log message bodies, transcripts and request URLs
at several levels. Instead of trusting every third-party call site, their
records are reduced to level, location and exception type. Only this package's
own records keep their text, and this package never logs content.
"""

import logging
import os
import re
import sys

from loguru import logger

OWN_PREFIX = "lu_voice_loop"

# Developer switch. Prints third-party messages in full, which can include
# transcripts and tool arguments. Never set by the app.
CONTENT_ENV = "LU_VOICE_LOG_CONTENT"


# An exception text can quote what it failed on. Long quoted strings and long
# unbroken runs (keys, tokens, encoded data) are cut out, short names stay.
_QUOTED = re.compile(r"""(["'])(?:(?!\1).){41,}\1""", re.DOTALL)
_RUN = re.compile(r"[A-Za-z0-9+/=_\-]{33,}")
MAX_ERROR_CHARS = 300


def safe_text(text: str) -> str:
    """A message from a library, reduced to what may reach the log.

    Quoted passages of more than 40 characters and unbroken runs of more than
    32 are replaced, the rest becomes one line of at most 300 characters.
    """
    text = _QUOTED.sub("[redacted]", text)
    text = _RUN.sub("[redacted]", text)
    text = " ".join(text.split())
    if len(text) > MAX_ERROR_CHARS:
        text = text[:MAX_ERROR_CHARS].rstrip() + " ..."
    return text


def safe_error_text(e: BaseException) -> str:
    """One exception for the log: its type and what it says, without content.

    The type alone ("RuntimeError") did not say why a session ended. An
    operating system error keeps its number and not its localized sentence.
    """
    name = type(e).__name__
    if isinstance(e, OSError):
        code = getattr(e, "winerror", None) or e.errno
        return name if code is None else "%s (os error %s)" % (name, code)
    try:
        text = safe_text(str(e))
    except Exception:
        text = ""
    return "%s: %s" % (name, text) if text else name


def pipeline_error_line(frame) -> str:
    """The log line for an error frame that travelled up the pipeline."""
    where = type(getattr(frame, "processor", None)).__name__ if getattr(frame, "processor", None) is not None else "the pipeline"
    fatal = " (fatal)" if getattr(frame, "fatal", False) else ""
    text = safe_text(str(getattr(frame, "error", "") or "")) or "no text"
    return "Pipeline error in %s%s: %s" % (where, fatal, text)


def _is_own(name: str | None) -> bool:
    return bool(name) and (name == OWN_PREFIX or name.startswith(OWN_PREFIX + "."))


def redact_record(name: str | None, function: str, line: int, message: str, exc_type: str | None) -> str:
    """Return the text that is allowed to reach the log for one record."""
    if _is_own(name):
        return message
    suffix = " (%s)" % exc_type if exc_type else ""
    return "%s:%s:%s%s" % (name or "unknown", function, line, suffix)


def _loguru_format(record) -> str:
    exc = record["exception"]
    exc_type = exc.type.__name__ if exc and exc.type else None
    text = redact_record(record["name"], record["function"], record["line"], record["message"], exc_type)
    record["extra"]["safe"] = text
    return "{time:HH:mm:ss.SSS} {level: <7} {extra[safe]}\n"


class _StdlibRedactor(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        exc_type = record.exc_info[0].__name__ if record.exc_info and record.exc_info[0] else None
        try:
            message = record.getMessage()
        except Exception:
            message = ""
        text = redact_record(record.name, record.funcName, record.lineno, message, exc_type)
        return "%s %-7s %s" % (self.formatTime(record, "%H:%M:%S"), record.levelname, text)


def setup_logging(stream=None) -> None:
    """Route loguru and stdlib logging to stderr through the redactor."""
    stream = stream or sys.stderr
    full = os.environ.get(CONTENT_ENV) == "1"
    logger.remove()
    if full:
        logger.add(stream, level="DEBUG")
    else:
        # diagnose/backtrace print local variables, which can hold content.
        logger.add(stream, level="INFO", format=_loguru_format, backtrace=False, diagnose=False,
                   filter=lambda r: _is_own(r["name"]) or r["level"].no >= 30)

    handler = logging.StreamHandler(stream)
    if not full:
        handler.setFormatter(_StdlibRedactor())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.DEBUG if full else logging.WARNING)
