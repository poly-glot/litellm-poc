"""Unit tests for AcmeMcpRptHook — token gating, exchange, caching, rate gate, fail-closed errors."""

from types import SimpleNamespace

import httpx
import pytest
import respx
from fastapi import HTTPException

from conftest import ACCESS_API_TEMPLATE, DISCOVERY_API, ISSUER, exchangeable_token, forge_jwt

ACCESS_API = ACCESS_API_TEMPLATE.replace("{region}", "euw1")


def hook_data(server_name="tenant_a", bearer=None):
    data = {"mcp_server_name": server_name}
    if bearer is not None:
        data["incoming_bearer_token"] = bearer
    return data


def rpt_token(tenant="tenant-a"):
    return forge_jwt({"aud": "client", "iss": "http://localhost:4014", "sub": "admin_a@test.com"})


def budget_table(rpm_limit=None, max_budget=None):
    return SimpleNamespace(max_budget=max_budget, rpm_limit=rpm_limit)


@pytest.fixture
def budget_spy(monkeypatch):
    from litellm.proxy.auth import auth_checks

    spy = SimpleNamespace(lookups=[], default_budget=None, end_user=None)

    async def fake_get_end_user_object(**kwargs):
        spy.lookups.append((kwargs["end_user_id"], kwargs["route"]))
        return spy.end_user

    async def fake_get_default_end_user_budget(**kwargs):
        return spy.default_budget

    monkeypatch.setattr(auth_checks, "get_end_user_object", fake_get_end_user_object)
    monkeypatch.setattr(auth_checks, "get_default_end_user_budget", fake_get_default_end_user_budget)
    return spy


async def test_non_mcp_call_type_passes_through(hook, cache):
    data = hook_data(bearer=exchangeable_token())
    result = await hook.async_pre_call_hook(None, cache, data, "completion")
    assert result is data


async def test_non_jwt_bearer_passes_through(hook, cache):
    data = hook_data(bearer="sk-local-dev")
    result = await hook.async_pre_call_hook(None, cache, data, "call_mcp_tool")
    assert result is data
    assert "extra_headers" not in data


async def test_missing_server_name_passes_through(hook, cache):
    data = {"incoming_bearer_token": exchangeable_token()}
    result = await hook.async_pre_call_hook(None, cache, data, "call_mcp_tool")
    assert result is data


@pytest.mark.parametrize(
    "audience",
    ["client", ["client"], ["account", "client"]],
    ids=["string", "list", "mixed-list"],
)
def test_rpt_audience_never_reexchanged(hook, audience):
    assert hook._is_exchangeable_idp_token(exchangeable_token(audience=audience)) is False


@pytest.mark.parametrize(
    "bearer",
    [
        exchangeable_token(issuer="https://other-idp.test/realms/acme"),
        "two.segments",
        forge_jwt({"aud": "account"})[:-30] + ".!!notbase64!!",
        "",
    ],
    ids=["wrong-issuer", "not-jwt", "corrupt-payload", "empty"],
)
def test_non_exchangeable_shapes(hook, bearer):
    assert hook._is_exchangeable_idp_token(bearer) is False


def test_exchangeable_idp_token(hook):
    assert hook._is_exchangeable_idp_token(exchangeable_token()) is True


def test_comma_separated_issuer_list_accepts_every_region():
    from conftest import ACCESS_API_TEMPLATE as access_template, DISCOVERY_API as discovery
    from acme_mcp_rpt_hook import AcmeMcpRptHook

    us_issuer = ISSUER.replace("/eu/", "/us/") if "/eu/" in ISSUER else "https://keycloak-us.acme.test/realms/acme"
    multi = AcmeMcpRptHook(
        access_api_template=access_template,
        client_discovery_api=discovery,
        guardrail_name="acme-mcp-rpt",
        oauth_issuer_template=f"{ISSUER}, {us_issuer}",
        realm="acme",
    )

    assert multi._is_exchangeable_idp_token(exchangeable_token()) is True
    assert multi._is_exchangeable_idp_token(exchangeable_token(issuer=us_issuer)) is True
    assert multi._is_exchangeable_idp_token(exchangeable_token(issuer="https://other-idp.test/realms/acme")) is False


@pytest.mark.parametrize(
    ("server_name", "tenant"),
    [("tenant_a", "tenant-a"), ("acme", "acme"), ("tenant_b", "tenant-b")],
)
def test_tenant_decode_bijective(hook, server_name, tenant):
    assert hook._extract_tenant({"mcp_server_name": server_name}) == tenant
    assert tenant.replace("-", "_") == server_name


@respx.mock
async def test_exchange_success_injects_rpt_without_mutating_input(hook, cache):
    respx.get(f"{DISCOVERY_API}/region/tenant-a").respond(200, text="euw1")
    respx.post(f"{ACCESS_API}/token").respond(200, json={"access_token": "rpt-123", "expires_in": 300})

    data = hook_data(bearer=exchangeable_token())
    result = await hook.async_pre_call_hook(None, cache, data, "call_mcp_tool")

    assert result is not data
    assert result["extra_headers"]["Authorization"] == "Bearer rpt-123"
    assert result["extra_headers"]["x-tenant-id"] == "tenant-a"
    assert result["extra_headers"]["x-tenant-region"] == "euw1"
    assert "extra_headers" not in data


@respx.mock
async def test_exchange_merges_existing_extra_headers(hook, cache):
    respx.get(f"{DISCOVERY_API}/region/tenant-a").respond(200, text="euw1")
    respx.post(f"{ACCESS_API}/token").respond(200, json={"access_token": "rpt-123", "expires_in": 300})

    data = hook_data(bearer=exchangeable_token())
    data["extra_headers"] = {"x-existing": "kept"}
    result = await hook.async_pre_call_hook(None, cache, data, "call_mcp_tool")

    assert result["extra_headers"]["x-existing"] == "kept"
    assert result["extra_headers"]["Authorization"] == "Bearer rpt-123"
    assert result["extra_headers"]["x-tenant-region"] == "euw1"


@respx.mock
async def test_unknown_tenant_fails_closed_400(hook, cache):
    respx.get(f"{DISCOVERY_API}/region/nope").respond(404)

    with pytest.raises(HTTPException) as exc_info:
        await hook.async_pre_call_hook(None, cache, hook_data("nope", exchangeable_token()), "call_mcp_tool")
    assert exc_info.value.status_code == 400


@respx.mock
async def test_not_entitled_fails_closed_403(hook, cache):
    respx.get(f"{DISCOVERY_API}/region/tenant-a").respond(200, text="euw1")
    respx.post(f"{ACCESS_API}/token").respond(403)

    with pytest.raises(HTTPException) as exc_info:
        await hook.async_pre_call_hook(None, cache, hook_data(bearer=exchangeable_token()), "call_mcp_tool")
    assert exc_info.value.status_code == 403


@respx.mock
async def test_exchange_error_fails_closed_401_without_token_leak(hook, cache):
    respx.get(f"{DISCOVERY_API}/region/tenant-a").respond(200, text="euw1")
    respx.post(f"{ACCESS_API}/token").respond(500)

    bearer = exchangeable_token()
    with pytest.raises(HTTPException) as exc_info:
        await hook.async_pre_call_hook(None, cache, hook_data(bearer=bearer), "call_mcp_tool")

    assert exc_info.value.status_code == 401
    assert bearer not in str(exc_info.value.detail)


@pytest.mark.parametrize(
    "body",
    [
        {"expires_in": 300},
        {"access_token": "", "expires_in": 300},
        {"access_token": "rpt-123", "expires_in": "soon"},
    ],
    ids=["no-access-token", "empty-access-token", "unusable-expiry"],
)
@respx.mock
async def test_unusable_exchange_body_fails_closed_401(hook, cache, body):
    respx.get(f"{DISCOVERY_API}/region/tenant-a").respond(200, text="euw1")
    respx.post(f"{ACCESS_API}/token").respond(200, json=body)

    with pytest.raises(HTTPException) as exc_info:
        await hook.async_pre_call_hook(None, cache, hook_data(bearer=exchangeable_token()), "call_mcp_tool")

    assert exc_info.value.status_code == 401


@respx.mock
async def test_rpt_cached_per_token_and_tenant(hook, cache):
    discovery = respx.get(f"{DISCOVERY_API}/region/tenant-a").respond(200, text="euw1")
    access = respx.post(f"{ACCESS_API}/token").respond(200, json={"access_token": "rpt-123", "expires_in": 300})

    bearer = exchangeable_token()
    await hook.async_pre_call_hook(None, cache, hook_data(bearer=bearer), "call_mcp_tool")
    await hook.async_pre_call_hook(None, cache, hook_data(bearer=bearer), "call_mcp_tool")

    assert discovery.call_count == 1
    assert access.call_count == 1


@respx.mock
async def test_pooled_client_reused_across_hook_calls(hook, cache):
    respx.get(f"{DISCOVERY_API}/region/tenant-a").respond(200, text="euw1")
    respx.get(f"{DISCOVERY_API}/region/tenant-b").respond(200, text="euw1")
    respx.post(f"{ACCESS_API}/token").respond(200, json={"access_token": "rpt-123", "expires_in": 300})

    bearer = exchangeable_token()
    await hook.async_pre_call_hook(None, cache, hook_data("tenant_a", bearer), "call_mcp_tool")
    pooled = hook._http_client
    await hook.async_pre_call_hook(None, cache, hook_data("tenant_b", bearer), "call_mcp_tool")

    assert pooled is not None
    assert hook._http_client is pooled


async def test_spend_budget_never_gates_mcp(hook, cache, proxy_state, budget_spy, monkeypatch):
    from litellm.proxy.auth import auth_checks

    proxy_state.prisma_client = object()
    budget_spy.end_user = SimpleNamespace(litellm_budget_table=budget_table(max_budget=0.0))

    async def refuse(*args, **kwargs):
        raise AssertionError("MCP must not consult the spend budget")

    monkeypatch.setattr(auth_checks, "_check_end_user_budget", refuse)

    data = hook_data(bearer=rpt_token())
    assert await hook.async_pre_call_hook(None, cache, data, "call_mcp_tool") is data


@respx.mock
async def test_idp_bearer_exchanges_without_budget_check(hook, cache, proxy_state, budget_spy):
    respx.get(f"{DISCOVERY_API}/region/tenant-a").respond(200, text="euw1")
    respx.post(f"{ACCESS_API}/token").respond(200, json={"access_token": "rpt-123", "expires_in": 300})
    proxy_state.prisma_client = object()
    budget_spy.end_user = object()

    result = await hook.async_pre_call_hook(None, cache, hook_data(bearer=exchangeable_token()), "call_mcp_tool")

    assert result["extra_headers"]["Authorization"] == "Bearer rpt-123"
    assert budget_spy.lookups == [("tenant-a", "/mcp/tools/call")]


async def test_config_default_rate_limits_without_db(cache, proxy_state):
    from acme_mcp_rpt_hook import AcmeMcpRptHook

    hook = AcmeMcpRptHook(
        access_api_template=ACCESS_API_TEMPLATE,
        client_discovery_api=DISCOVERY_API,
        default_mcp_rpm_limit=1,
        guardrail_name="acme-mcp-rpt",
        oauth_issuer_template=ISSUER,
        realm="acme",
    )

    assert await hook.async_pre_call_hook(None, cache, hook_data(bearer=rpt_token()), "call_mcp_tool") is not None

    with pytest.raises(HTTPException) as exc_info:
        await hook.async_pre_call_hook(None, cache, hook_data(bearer=rpt_token()), "call_mcp_tool")

    assert exc_info.value.status_code == 429


async def test_budget_row_rpm_overrides_config_default(cache, proxy_state, budget_spy):
    from acme_mcp_rpt_hook import AcmeMcpRptHook

    hook = AcmeMcpRptHook(
        access_api_template=ACCESS_API_TEMPLATE,
        client_discovery_api=DISCOVERY_API,
        default_mcp_rpm_limit=1,
        guardrail_name="acme-mcp-rpt",
        oauth_issuer_template=ISSUER,
        realm="acme",
    )
    proxy_state.prisma_client = object()
    budget_spy.end_user = SimpleNamespace(litellm_budget_table=budget_table(rpm_limit=3))

    for _ in range(3):
        assert await hook.async_pre_call_hook(None, cache, hook_data(bearer=rpt_token()), "call_mcp_tool") is not None

    with pytest.raises(HTTPException):
        await hook.async_pre_call_hook(None, cache, hook_data(bearer=rpt_token()), "call_mcp_tool")


async def test_listing_never_rate_gated(hook, cache, proxy_state, budget_spy):
    proxy_state.prisma_client = object()

    data = hook_data(bearer=rpt_token())
    result = await hook.async_pre_call_hook(None, cache, data, "list_mcp_tools")

    assert result is data
    assert budget_spy.lookups == []


@respx.mock
async def test_tenant_without_customer_row_passes_gate(hook, cache, proxy_state, budget_spy):
    respx.get(f"{DISCOVERY_API}/region/tenant-a").respond(200, text="euw1")
    respx.post(f"{ACCESS_API}/token").respond(200, json={"access_token": "rpt-123", "expires_in": 300})
    proxy_state.prisma_client = object()

    result = await hook.async_pre_call_hook(None, cache, hook_data(bearer=exchangeable_token()), "call_mcp_tool")

    assert result["extra_headers"]["Authorization"] == "Bearer rpt-123"
    assert budget_spy.lookups == [("tenant-a", "/mcp/tools/call")]


async def test_foreign_issuer_jwt_not_gated(hook, cache, proxy_state, budget_spy):
    proxy_state.prisma_client = object()

    data = hook_data(bearer=exchangeable_token(issuer="https://other-idp.test/realms/acme"))
    result = await hook.async_pre_call_hook(None, cache, data, "call_mcp_tool")

    assert result is data
    assert budget_spy.lookups == []


async def test_mcp_rpm_limit_blocks_after_window_quota(hook, cache, proxy_state, budget_spy):
    proxy_state.prisma_client = object()
    budget_spy.end_user = SimpleNamespace(litellm_budget_table=budget_table(rpm_limit=2))

    for _ in range(2):
        result = await hook.async_pre_call_hook(None, cache, hook_data(bearer=rpt_token()), "call_mcp_tool")
        assert result is not None

    with pytest.raises(HTTPException) as exc_info:
        await hook.async_pre_call_hook(None, cache, hook_data(bearer=rpt_token()), "call_mcp_tool")

    assert exc_info.value.status_code == 429
    assert "MCP rate limit exceeded for tenant 'tenant-a'" in exc_info.value.detail["error"]
    assert 0 <= exc_info.value.detail["retry_after_seconds"] <= 60


async def test_mcp_rpm_unlimited_without_configured_limit(hook, cache, proxy_state, budget_spy):
    proxy_state.prisma_client = object()
    budget_spy.end_user = SimpleNamespace(litellm_budget_table=budget_table(rpm_limit=None))

    for _ in range(5):
        result = await hook.async_pre_call_hook(None, cache, hook_data(bearer=rpt_token()), "call_mcp_tool")
        assert result is not None


async def test_rowless_tenant_rate_limited_via_default_budget(hook, cache, proxy_state, budget_spy):
    proxy_state.prisma_client = object()
    budget_spy.end_user = None
    budget_spy.default_budget = budget_table(rpm_limit=1)

    result = await hook.async_pre_call_hook(None, cache, hook_data(bearer=rpt_token()), "call_mcp_tool")
    assert result is not None

    with pytest.raises(HTTPException) as exc_info:
        await hook.async_pre_call_hook(None, cache, hook_data(bearer=rpt_token()), "call_mcp_tool")

    assert exc_info.value.status_code == 429


async def test_mcp_rpm_counters_scoped_per_tenant(hook, cache, proxy_state, budget_spy):
    proxy_state.prisma_client = object()
    budget_spy.end_user = SimpleNamespace(litellm_budget_table=budget_table(rpm_limit=1))

    assert await hook.async_pre_call_hook(None, cache, hook_data("tenant_a", rpt_token()), "call_mcp_tool") is not None
    with pytest.raises(HTTPException):
        await hook.async_pre_call_hook(None, cache, hook_data("tenant_a", rpt_token()), "call_mcp_tool")

    assert await hook.async_pre_call_hook(None, cache, hook_data("tenant_b", rpt_token()), "call_mcp_tool") is not None


@respx.mock
async def test_different_tenant_same_token_exchanges_again(hook, cache):
    respx.get(f"{DISCOVERY_API}/region/tenant-a").respond(200, text="euw1")
    respx.get(f"{DISCOVERY_API}/region/tenant-b").respond(200, text="euw1")
    access = respx.post(f"{ACCESS_API}/token").respond(200, json={"access_token": "rpt-123", "expires_in": 300})

    bearer = exchangeable_token()
    await hook.async_pre_call_hook(None, cache, hook_data("tenant_a", bearer), "call_mcp_tool")
    await hook.async_pre_call_hook(None, cache, hook_data("tenant_b", bearer), "call_mcp_tool")

    assert access.call_count == 2
