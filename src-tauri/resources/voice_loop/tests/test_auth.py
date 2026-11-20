"""Launch token, Origin, Host and the single-use WebSocket ticket."""

import httpx
import pytest
import websockets

from conftest import ORIGIN, TOKEN
from lu_voice_loop import auth


def test_launch_token_is_removed_from_the_environment():
    environ = {auth.TOKEN_ENV: "s" * 40, "OTHER": "1"}
    assert auth.read_launch_token(environ) == "s" * 40
    assert auth.TOKEN_ENV not in environ


@pytest.mark.parametrize("value", [None, "", "short", "x" * 31])
def test_missing_or_weak_launch_token_is_refused(value):
    environ = {} if value is None else {auth.TOKEN_ENV: value}
    with pytest.raises(ValueError, match="LU_VOICE_TOKEN"):
        auth.read_launch_token(environ)


def test_default_origins_are_the_tauri_webviews():
    assert auth.read_allowed_origins({}) == auth.DEFAULT_ORIGINS


def test_origins_from_environment_are_exact_matches():
    origins = auth.read_allowed_origins({auth.ORIGINS_ENV: "http://localhost:5173/, tauri://localhost"})
    assert origins == ("http://localhost:5173", "tauri://localhost")
    assert auth.origin_allowed("http://localhost:5173", origins)
    assert not auth.origin_allowed("http://localhost:5174", origins)
    assert not auth.origin_allowed("http://localhost:5173.evil.example", origins)
    assert not auth.origin_allowed(None, origins)
    assert not auth.origin_allowed("", origins)


@pytest.mark.parametrize("value", ["*", "tauri://localhost,*", "null"])
def test_wildcard_and_null_origins_are_refused(value):
    with pytest.raises(ValueError):
        auth.read_allowed_origins({auth.ORIGINS_ENV: value})


def test_bearer_needs_the_exact_token():
    assert auth.bearer_matches("Bearer " + TOKEN, TOKEN)
    assert not auth.bearer_matches("Bearer " + TOKEN + "x", TOKEN)
    assert not auth.bearer_matches(TOKEN, TOKEN)
    assert not auth.bearer_matches("Basic " + TOKEN, TOKEN)
    assert not auth.bearer_matches(None, TOKEN)


def test_host_must_be_the_loopback_address_and_port():
    assert auth.host_allowed("127.0.0.1:4000", 4000)
    assert auth.host_allowed("localhost:4000", 4000)
    assert not auth.host_allowed("127.0.0.1:4001", 4000)
    assert not auth.host_allowed("attacker.example:4000", 4000)
    assert not auth.host_allowed(None, 4000)


def test_ticket_works_once():
    store = auth.TicketStore()
    ticket = store.issue("payload")
    assert store.redeem(ticket) == "payload"
    assert store.redeem(ticket) is None
    assert store.redeem("unknown") is None
    assert store.redeem(None) is None


def test_ticket_expires():
    now = [100.0]
    store = auth.TicketStore(ttl_secs=30, clock=lambda: now[0])
    ticket = store.issue("payload")
    now[0] += 31
    assert store.redeem(ticket) is None


def test_open_tickets_are_bounded():
    store = auth.TicketStore()
    tickets = [store.issue(i) for i in range(auth.MAX_OPEN_TICKETS + 3)]
    assert store.redeem(tickets[0]) is None
    assert store.redeem(tickets[-1]) == auth.MAX_OPEN_TICKETS + 2


# ---- over HTTP and WebSocket ----------------------------------------------


async def test_health_needs_no_token_and_tells_no_secret(harness):
    async with httpx.AsyncClient() as http:
        response = await http.get(harness.base + "/health")
    assert response.status_code == 200
    assert response.json()["state"] == "ready"
    assert TOKEN not in response.text


async def test_session_needs_the_token(harness):
    async with httpx.AsyncClient() as http:
        missing = await http.post(harness.base + "/session", json=harness.config(), headers={"Origin": ORIGIN})
        wrong = await http.post(harness.base + "/session", json=harness.config(), headers=harness.headers(token="wrong" * 10))
    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert "wsUrl" not in missing.text + wrong.text


async def test_session_needs_an_allowed_origin(harness):
    async with httpx.AsyncClient() as http:
        foreign = await http.post(harness.base + "/session", json=harness.config(), headers=harness.headers(origin="https://evil.example"))
        absent = await http.post(harness.base + "/session", json=harness.config(), headers=harness.headers(origin=None))
    assert foreign.status_code == 403
    assert absent.status_code == 403


async def test_session_refuses_a_foreign_host_header(harness):
    headers = harness.headers() | {"Host": "rebind.example:%d" % harness.voice.port}
    async with httpx.AsyncClient() as http:
        response = await http.post(harness.base + "/session", json=harness.config(), headers=headers)
    assert response.status_code == 403


async def test_preflight_only_passes_for_allowed_origins(harness):
    preflight = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"}
    async with httpx.AsyncClient() as http:
        allowed = await http.options(harness.base + "/session", headers={"Origin": ORIGIN} | preflight)
        foreign = await http.options(harness.base + "/session", headers={"Origin": "https://evil.example"} | preflight)
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == ORIGIN
    assert "access-control-allow-origin" not in foreign.headers


async def test_session_answers_in_the_shape_the_js_transport_takes(harness):
    start = await harness.start()
    # WebSocketTransport rejects any key other than wsUrl and token.
    assert set(start) == {"wsUrl", "token"}
    assert start["wsUrl"] == "ws://127.0.0.1:%d/ws" % harness.voice.port
    assert TOKEN not in start["token"]


async def _handshake_status(url: str, origin: str | None = ORIGIN) -> int:
    headers = {"Origin": origin} if origin else {}
    try:
        async with websockets.connect(url, additional_headers=headers):
            return 101
    except websockets.InvalidStatus as e:
        return e.response.status_code


async def test_websocket_without_ticket_is_refused(harness):
    base = "ws://127.0.0.1:%d/ws" % harness.voice.port
    assert await _handshake_status(base) == 403
    assert await _handshake_status(base + "?token=guess") == 403
    # The launch token itself is not a ticket.
    assert await _handshake_status(base + "?token=" + TOKEN) == 403


async def test_websocket_with_a_foreign_origin_is_refused_and_keeps_the_ticket(harness):
    start = await harness.start()
    url = "%s?token=%s" % (start["wsUrl"], start["token"])
    assert await _handshake_status(url, origin="https://evil.example") == 403
    assert await _handshake_status(url, origin=None) == 403
    assert await _handshake_status(url) == 101


async def test_ticket_cannot_be_replayed(harness):
    start = await harness.start()
    url = "%s?token=%s" % (start["wsUrl"], start["token"])
    assert await _handshake_status(url) == 101
    assert await _handshake_status(url) == 403
