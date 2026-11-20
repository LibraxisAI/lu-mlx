"""Access control for the loopback service.

Three checks guard every session: the launch token the app handed over in the
environment, the Origin of the webview, and the Host the request was sent to
(a rebinding page reaches 127.0.0.1 under its own host name). The WebSocket
cannot carry an Authorization header from a browser, so POST /session trades
the launch token for a ticket that works once and expires quickly.
"""

import hmac
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any, Callable

TOKEN_ENV = "LU_VOICE_TOKEN"
ORIGINS_ENV = "LU_VOICE_ALLOWED_ORIGINS"

MIN_TOKEN_CHARS = 32
TICKET_TTL_SECS = 30.0
MAX_OPEN_TICKETS = 8

# The Tauri webview origins: macOS and Linux use the custom scheme, Windows
# serves the app from tauri.localhost. A dev server origin is passed in by the
# app through LU_VOICE_ALLOWED_ORIGINS.
DEFAULT_ORIGINS = ("tauri://localhost", "http://tauri.localhost", "https://tauri.localhost")


def read_launch_token(environ=os.environ) -> str:
    """Take the launch token out of the environment.

    It is removed so that nothing this process spawns can inherit it.
    Raises ValueError when it is missing or too short to be a real secret.
    """
    token = environ.pop(TOKEN_ENV, "")
    if len(token) < MIN_TOKEN_CHARS:
        raise ValueError(
            "%s must be set to a random secret of at least %d characters." % (TOKEN_ENV, MIN_TOKEN_CHARS)
        )
    return token


def read_allowed_origins(environ=os.environ) -> tuple[str, ...]:
    raw = environ.get(ORIGINS_ENV, "")
    origins = tuple(o.strip().rstrip("/").lower() for o in raw.split(",") if o.strip())
    if "*" in origins or "null" in origins:
        raise ValueError("%s must list exact origins. Wildcards and null are not accepted." % ORIGINS_ENV)
    return origins or DEFAULT_ORIGINS


def bearer_matches(header: str | None, token: str) -> bool:
    if not header or not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[len("Bearer "):].encode(), token.encode())


def origin_allowed(origin: str | None, allowed: tuple[str, ...]) -> bool:
    """A missing Origin is refused: every webview request carries one."""
    if not origin:
        return False
    return origin.rstrip("/").lower() in allowed


def host_allowed(host: str | None, port: int) -> bool:
    if not host:
        return False
    return host.lower() in ("127.0.0.1:%d" % port, "localhost:%d" % port)


@dataclass
class _Ticket:
    payload: Any
    expires_at: float


class TicketStore:
    """Single-use, short-lived tickets that bind a WebSocket to one session config."""

    def __init__(self, ttl_secs: float = TICKET_TTL_SECS, clock: Callable[[], float] = time.monotonic):
        self._ttl = ttl_secs
        self._clock = clock
        self._tickets: dict[str, _Ticket] = {}

    def issue(self, payload: Any) -> str:
        self._drop_expired()
        # Only the newest sessions can still be claimed. The oldest ticket goes first.
        while len(self._tickets) >= MAX_OPEN_TICKETS:
            self._tickets.pop(next(iter(self._tickets)))
        ticket = secrets.token_urlsafe(32)
        self._tickets[ticket] = _Ticket(payload, self._clock() + self._ttl)
        return ticket

    def redeem(self, ticket: str | None) -> Any | None:
        """Return the payload once, or None for an unknown, used or expired ticket."""
        if not ticket:
            return None
        found = None
        for known in list(self._tickets):
            if hmac.compare_digest(known.encode(), ticket.encode()):
                found = self._tickets.pop(known)
        if found is None or found.expires_at < self._clock():
            return None
        return found.payload

    def _drop_expired(self) -> None:
        now = self._clock()
        for ticket in [t for t, v in self._tickets.items() if v.expires_at < now]:
            del self._tickets[ticket]
