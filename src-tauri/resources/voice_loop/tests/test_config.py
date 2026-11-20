"""Session configuration validation."""

import httpx
import pytest
from pydantic import ValidationError

from conftest import CLOCK_TOOL
from lu_voice_loop.config import SessionConfig, describe_validation_error


def config(**overrides) -> dict:
    base = {"llm": {"base_url": "http://127.0.0.1:8127/v1", "model": "local"}, "tools": [CLOCK_TOOL]}
    base.update(overrides)
    return base


def test_minimal_config_gets_safe_defaults():
    parsed = SessionConfig.model_validate({"llm": {"base_url": "http://127.0.0.1:8127/v1/", "model": "m"}})
    assert parsed.llm.base_url == "http://127.0.0.1:8127/v1"
    assert parsed.llm.api_key is None
    assert parsed.tools == []
    assert parsed.voice == "alba"
    assert parsed.tool_timeout_secs == 130.0


def test_cloud_endpoint_with_bearer_is_accepted_and_the_key_stays_hidden():
    parsed = SessionConfig.model_validate(config(llm={
        "base_url": "https://lu-labs.ai/api/inference/v1", "model": "some/model", "api_key": "secret-key-123",
    }))
    assert parsed.llm.api_key.get_secret_value() == "secret-key-123"
    assert "secret-key-123" not in repr(parsed)
    assert "secret-key-123" not in parsed.model_dump_json()


@pytest.mark.parametrize("url", ["ftp://host/v1", "127.0.0.1:8127", "", "file:///etc/passwd", "http://user:pw@host/v1"])
def test_bad_base_url_is_refused(url):
    with pytest.raises(ValidationError):
        SessionConfig.model_validate(config(llm={"base_url": url, "model": "m"}))


def test_unknown_fields_are_refused():
    with pytest.raises(ValidationError):
        SessionConfig.model_validate(config(shell="bash"))
    with pytest.raises(ValidationError):
        SessionConfig.model_validate(config(llm={"base_url": "http://h/v1", "model": "m", "exec": True}))


@pytest.mark.parametrize("key", ["model", "messages", "tools", "stream"])
def test_extra_cannot_replace_what_the_session_controls(key):
    with pytest.raises(ValidationError):
        SessionConfig.model_validate(config(llm={"base_url": "http://h/v1", "model": "m", "extra": {key: 1}}))


def test_extra_passes_through():
    parsed = SessionConfig.model_validate(config(llm={
        "base_url": "http://h/v1", "model": "m", "extra": {"reasoning_effort": "none"},
    }))
    assert parsed.llm.extra == {"reasoning_effort": "none"}


@pytest.mark.parametrize("name", ["", "has space", "semi;colon", "x" * 101, "dot.name"])
def test_bad_tool_name_is_refused(name):
    tool = {"type": "function", "function": {"name": name, "parameters": {"type": "object", "properties": {}}}}
    with pytest.raises(ValidationError):
        SessionConfig.model_validate(config(tools=[tool]))


def test_duplicate_tool_names_are_refused():
    with pytest.raises(ValidationError, match="unique"):
        SessionConfig.model_validate(config(tools=[CLOCK_TOOL, CLOCK_TOOL]))


def test_tool_parameters_must_be_an_object_schema():
    tool = {"type": "function", "function": {"name": "t", "parameters": {"type": "string"}}}
    with pytest.raises(ValidationError):
        SessionConfig.model_validate(config(tools=[tool]))


def test_long_running_tools_must_be_offered():
    with pytest.raises(ValidationError, match="not offered"):
        SessionConfig.model_validate(config(long_running_tools=["computer_use"]))
    parsed = SessionConfig.model_validate(config(long_running_tools=["get_current_time"]))
    assert parsed.long_running_tools == ["get_current_time"]


def test_cancel_name_of_a_long_running_tool_is_reserved():
    clash = {"type": "function", "function": {"name": "cancel_get_current_time"}}
    with pytest.raises(ValidationError, match="reserved"):
        SessionConfig.model_validate(config(tools=[CLOCK_TOOL, clash], long_running_tools=["get_current_time"]))


@pytest.mark.parametrize("secs", [0, 0.5, 621, -1])
def test_tool_timeout_is_bounded(secs):
    with pytest.raises(ValidationError):
        SessionConfig.model_validate(config(tool_timeout_secs=secs))


def test_validation_message_names_the_field_but_never_echoes_values():
    secret_prompt = "PRIVATE PROMPT TEXT"
    try:
        SessionConfig.model_validate(config(system_prompt=secret_prompt, tool_timeout_secs=9999, llm={
            "base_url": "nope", "model": "m", "api_key": "sk-very-secret",
        }))
    except ValidationError as e:
        text = describe_validation_error(e)
    assert "llm.base_url" in text and "tool_timeout_secs" in text
    assert secret_prompt not in text and "sk-very-secret" not in text and "9999" not in text


# ---- over HTTP --------------------------------------------------------------


async def test_invalid_config_is_a_422_without_a_ticket(harness):
    async with httpx.AsyncClient() as http:
        response = await http.post(harness.base + "/session", json={"llm": {"base_url": "nope", "model": "m"}}, headers=harness.headers())
    assert response.status_code == 422
    assert "llm.base_url" in response.json()["error"]
    assert "token" not in response.json()


async def test_body_that_is_not_json_is_a_400(harness):
    async with httpx.AsyncClient() as http:
        response = await http.post(harness.base + "/session", content=b"{not json", headers=harness.headers())
    assert response.status_code == 400


async def test_a_voice_that_is_not_installed_is_a_422(harness):
    async with httpx.AsyncClient() as http:
        response = await http.post(harness.base + "/session", json=harness.config(voice="nobody"), headers=harness.headers())
    assert response.status_code == 422
    assert response.json()["error"] == "The voice nobody is not installed."


async def test_oversized_body_is_a_413(harness):
    body = harness.config(system_prompt="x" * 150_000)
    body["tools"] = [
        {"type": "function", "function": {"name": "t%d" % i, "description": "d" * 8000}} for i in range(120)
    ]
    async with httpx.AsyncClient() as http:
        response = await http.post(harness.base + "/session", json=body, headers=harness.headers())
    assert response.status_code == 413
