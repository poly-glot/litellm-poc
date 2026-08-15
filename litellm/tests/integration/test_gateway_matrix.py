"""Black-box gateway matrix — runs against a live LiteLLM gateway (layer C).

Gated on GATEWAY_URL (e.g. http://litellm:4000 in the devcontainer, or a compose stack
in CI). Every case here asserts only what an external MCP client can observe; what the
gateway forwards upstream is covered by the layer A hook tests.
"""

import json
import os
import time

import httpx
import pytest

pytestmark = pytest.mark.integration

GATEWAY_URL = os.getenv("GATEWAY_URL", "").rstrip("/")
TEMPLATE = os.getenv("GATEWAY_TEMPLATE_SERVER", "tenant_a")
MINTED_TENANT = os.getenv("GATEWAY_MINTED_TENANT", "tenant_b")
GATEWAY_OAUTH_ISSUER = os.getenv("GATEWAY_OAUTH_ISSUER", "https://keycloak.acme.test/realms/acme")

if not GATEWAY_URL:
    pytest.skip("GATEWAY_URL not set", allow_module_level=True)

from conftest import forge_jwt

LISTING_BEARER = forge_jwt({"aud": "client", "iss": GATEWAY_OAUTH_ISSUER, "sub": "listing-probe"})

MCP_HEADERS = {
    "accept": "application/json, text/event-stream",
    "content-type": "application/json",
}


def rpc(method: str, params: dict | None = None) -> dict:
    return {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}


def tool_names(response: httpx.Response) -> list[str]:
    for line in response.text.splitlines():
        if line.startswith("data:"):
            payload = json.loads(line[len("data:") :])
            return [tool["name"] for tool in payload.get("result", {}).get("tools", [])]
    return []


def list_tools(server: str, bearer: str | None = LISTING_BEARER) -> httpx.Response:
    headers = dict(MCP_HEADERS)
    if bearer:
        headers["authorization"] = f"Bearer {bearer}"
    return httpx.post(f"{GATEWAY_URL}/mcp/{server}", headers=headers, json=rpc("tools/list"), timeout=30)


def test_registered_template_lists_prefixed_tools():
    names = tool_names(list_tools(TEMPLATE))
    assert names
    assert all(name.startswith(f"{TEMPLATE}-") for name in names)


def test_unregistered_tenant_mints_and_lists_same_tools():
    template_names = tool_names(list_tools(TEMPLATE))
    minted_names = tool_names(list_tools(MINTED_TENANT))

    assert template_names
    assert minted_names

    stripped = lambda names, prefix: sorted(name.removeprefix(f"{prefix}-") for name in names)
    assert stripped(minted_names, MINTED_TENANT) == stripped(template_names, TEMPLATE)


def test_bare_request_gets_oauth_challenge_with_tenant_metadata():
    response = httpx.post(f"{GATEWAY_URL}/mcp/{MINTED_TENANT}", headers=MCP_HEADERS, json=rpc("initialize"), timeout=15)

    assert response.status_code == 401
    challenge = response.headers.get("www-authenticate", "")
    assert f"/.well-known/oauth-protected-resource/mcp/{MINTED_TENANT}" in challenge


def test_garbage_name_converges_to_native_401():
    garbage = f"zz_garbage_{int(time.time())}"

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = list_tools(garbage)
        if response.status_code == 401:
            break
        time.sleep(1)

    assert response.status_code == 401


def test_discovery_metadata_is_https_consistent():
    prm = httpx.get(f"{GATEWAY_URL}/.well-known/oauth-protected-resource/mcp/{MINTED_TENANT}", timeout=15).json()

    resource = prm["resource"]
    authorization_server = prm["authorization_servers"][0]
    assert resource.split("://")[0] == authorization_server.split("://")[0]
    assert resource.endswith(f"/mcp/{MINTED_TENANT}")
