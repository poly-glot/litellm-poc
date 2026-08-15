"""Black-box tenant limit gates — runs against a live LiteLLM gateway (layer C).

Unlike the matrix tests, which only need a bearer SHAPED like a JWT, both gates here need
a real tenant principal: each case completes the PKCE login the Identity service serves
and lets the gateway run the RPT exchange, so the whole chain — Identity, Discovery, the
Access API, the budget rows — is in the assertion.

Each gate rides its own fixture tenant so the limits cannot collide: the MCP rate gate
uses tenant-c's budget row (rpm_limit), the completions spend gate uses tenant-e's
(max_budget). An rpm_limit on the spend tenant would let LiteLLM's native end-user rate
limiter refuse the second completion before the budget does, which would pass for the
wrong reason.

Setup is create-if-missing and never an update, because LiteLLM caches management objects
for ~60s: a row changed mid-run is invisible to the gateway until the TTL expires, so a
test that edited limits would assert against the old ones. Both tests therefore assert the
SHAPE of the refusal within a bounded number of attempts rather than pinning which attempt
refuses — a rerun inside the same rate window, or against a tenant whose spend is already
over, is refused earlier, and that is still a pass.

These cases write to the gateway's own database (one budget row and one customer row per
tenant), which is the operating path the README documents.
"""

import base64
import hashlib
import json
import os
import re
import secrets

import httpx
import pytest

pytestmark = pytest.mark.integration

GATEWAY_URL = os.getenv("GATEWAY_URL", "").rstrip("/")
IDENTITY_URL = os.getenv("IDENTITY_URL", "http://localhost:4018").rstrip("/")
MASTER_KEY = os.getenv("LITELLM_MASTER_KEY", "sk-litellm-dev")

if not GATEWAY_URL:
    pytest.skip("GATEWAY_URL not set", allow_module_level=True)

RATE_TENANT = "tenant-c"
RATE_USER = "admin_c@test.com"
RATE_BUDGET_ID = "acme-integration-rate"
RATE_CALL_CEILING = 70

SPEND_TENANT = "tenant-e"
SPEND_USER = "admin_e@test.com"
SPEND_BUDGET_ID = "acme-integration-spend"
SPEND_CALL_CEILING = 3

FIXTURE_PASSWORD = "123456"
MCP_HEADERS = {
    "accept": "application/json, text/event-stream",
    "content-type": "application/json",
}


def management(path: str, payload: dict) -> httpx.Response:
    return httpx.post(
        f"{GATEWAY_URL}{path}",
        headers={"authorization": f"Bearer {MASTER_KEY}", "content-type": "application/json"},
        json=payload,
        timeout=30,
    )


def customer_budget_id(tenant: str) -> str | None:
    response = httpx.get(
        f"{GATEWAY_URL}/customer/info",
        headers={"authorization": f"Bearer {MASTER_KEY}"},
        params={"end_user_id": tenant},
        timeout=30,
    )
    if response.status_code != 200:
        return None

    return response.json().get("budget_id")


def ensure_tenant_budget(tenant: str, budget_id: str, limits: dict) -> None:
    management("/budget/new", {"budget_id": budget_id, **limits})
    management("/customer/new", {"user_id": tenant, "budget_id": budget_id})

    if customer_budget_id(tenant) != budget_id:
        management("/customer/update", {"user_id": tenant, "budget_id": budget_id})
        pytest.skip(f"{tenant} was not carrying {budget_id}; attached now, visible after the ~60s cache TTL")


def login(email: str, region: str, tenant: str) -> str:
    verifier = secrets.token_urlsafe(48)[:64]
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    redirect_uri = f"http://localhost:4000/{tenant}/oauth2/callback"

    authorize = httpx.post(
        f"{IDENTITY_URL}/{region}/oidc/authorize",
        data={
            "client_id": "poc",
            "code_challenge": challenge,
            "email": email,
            "password": FIXTURE_PASSWORD,
            "redirect_uri": redirect_uri,
            "state": "integration",
        },
        follow_redirects=False,
        timeout=30,
    )
    code = re.search(r"[?&]code=([^&]+)", authorize.headers.get("location", ""))
    assert code, f"no authorization code for {email}: {authorize.status_code} {authorize.text[:120]}"

    token = httpx.post(
        f"{IDENTITY_URL}/{region}/oidc/token",
        data={
            "client_id": "poc",
            "code": code.group(1),
            "code_verifier": verifier,
            "grant_type": "authorization_code",
            "redirect_uri": redirect_uri,
        },
        timeout=30,
    )
    return token.json()["access_token"]


def call_tool(tenant: str, bearer: str) -> httpx.Response:
    server = tenant.replace("-", "_")
    return httpx.post(
        f"{GATEWAY_URL}/mcp/{server}",
        headers={**MCP_HEADERS, "authorization": f"Bearer {bearer}"},
        json={
            "id": 1,
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"arguments": {}, "name": f"{server}-list_projects"},
        },
        timeout=60,
    )


def rpc_result(response: httpx.Response) -> dict:
    for line in response.text.splitlines():
        if line.startswith("data:"):
            return json.loads(line[len("data:") :]).get("result") or {}

    return {}


def result_text(result: dict) -> str:
    return "".join(block.get("text", "") for block in result.get("content") or [])


def completion(tenant: str, bearer: str) -> httpx.Response:
    return httpx.post(
        f"{GATEWAY_URL}/v1/chat/completions",
        headers={"authorization": f"Bearer {bearer}", "content-type": "application/json"},
        json={
            "max_tokens": 1,
            "messages": [{"content": "/no_think hi", "role": "user"}],
            "metadata": {"tags": ["agent:integration", f"tenant:{tenant}"]},
            "model": "qwen3-local",
        },
        timeout=300,
    )


def test_tenant_mcp_tool_calls_are_rate_limited():
    ensure_tenant_budget(RATE_TENANT, RATE_BUDGET_ID, {"rpm_limit": 1})
    bearer = login(RATE_USER, "eu", RATE_TENANT)

    for _ in range(RATE_CALL_CEILING):
        response = call_tool(RATE_TENANT, bearer)
        assert response.status_code == 200

        result = rpc_result(response)
        if result.get("isError"):
            break
    else:
        pytest.fail(f"{RATE_TENANT} was never rate limited in {RATE_CALL_CEILING} tools/call")

    refusal = result_text(result)
    assert f"MCP rate limit exceeded for tenant '{RATE_TENANT}'" in refusal
    assert bearer not in refusal

    retry_after = re.search(r"retry_after_seconds'?:\s*(\d+)", refusal)
    assert retry_after, refusal
    assert 0 <= int(retry_after.group(1)) <= 60


def test_tenant_completions_are_refused_over_budget():
    ensure_tenant_budget(SPEND_TENANT, SPEND_BUDGET_ID, {"max_budget": 0.000001})
    bearer = login(SPEND_USER, "eu", SPEND_TENANT)

    for _ in range(SPEND_CALL_CEILING):
        response = completion(SPEND_TENANT, bearer)
        if response.status_code == 429:
            break
    else:
        pytest.fail(f"{SPEND_TENANT} was never refused in {SPEND_CALL_CEILING} completions")

    error = response.json().get("error") or {}
    assert error.get("type") == "budget_exceeded", error
    assert SPEND_TENANT in error.get("message", "")
    assert bearer not in response.text
