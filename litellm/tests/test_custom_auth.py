"""Unit tests for acme_custom_auth — lane precedence, RPT verification, IDP exchange, key mirrors."""

import json
import time
from types import SimpleNamespace

import litellm
import pytest
import respx
import jwt as pyjwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from starlette.requests import Request

from conftest import ACCESS_API_TEMPLATE, DISCOVERY_API, ISSUER, ISSUER_TEMPLATE, REALM, forge_jwt

ACCESS_API = ACCESS_API_TEMPLATE.replace("{region}", "euw1")
KID = "unit-kid"
ROGUE_KID = "rogue-kid"


def generate_keypair(kid):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    jwk = json.loads(pyjwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"alg": "RS256", "kid": kid, "use": "sig"})
    return SimpleNamespace(jwk=jwk, kid=kid, private_pem=private_pem)


@pytest.fixture(scope="module")
def access_keys():
    return generate_keypair(KID)


@pytest.fixture(scope="module")
def rogue_keys():
    return generate_keypair(ROGUE_KID)


@pytest.fixture
def auth(proxy_state):
    from acme_custom_auth import AcmeCompletionAuth

    return AcmeCompletionAuth(
        access_api_template=ACCESS_API_TEMPLATE,
        client_discovery_api=DISCOVERY_API,
        oauth_issuer_template=ISSUER_TEMPLATE,
        realm=REALM,
    )


def sign_rpt(keys, kid=None, tenant="tenant-a", **overrides):
    claims = {
        "aud": "client",
        "exp": int(time.time()) + 300,
        "iat": int(time.time()),
        "iss": "http://localhost:4014",
        "permissions": [{"rsname": f"acme.client:{tenant}", "scopes": ["access"]}],
        "sub": "admin_a@test.com",
    }
    claims.update(overrides)
    return pyjwt.encode(claims, keys.private_pem, algorithm="RS256", headers={"kid": kid or keys.kid})


def idp_token(email="admin_a@test.com", issuer=ISSUER):
    return forge_jwt({"aud": "account", "email": email, "iss": issuer, "sub": "user-1"})


def build_request(path="/v1/chat/completions", body=None):
    payload = json.dumps(body or {}).encode()
    scope = {
        "headers": [(b"content-type", b"application/json")],
        "method": "POST",
        "path": path,
        "query_string": b"",
        "root_path": "",
        "type": "http",
    }

    async def receive():
        return {"body": payload, "more_body": False, "type": "http.request"}

    return Request(scope, receive)


def mock_discovery(tenant="tenant-a", region="euw1"):
    return respx.get(f"{DISCOVERY_API}/region/{tenant}").respond(200, text=region)


def mock_jwks(keys):
    return respx.get(f"{ACCESS_API}/.well-known/jwks.json").respond(200, json={"keys": [keys.jwk]})


@respx.mock
async def test_rpt_bearer_authenticates_with_tenant_identity(auth, access_keys):
    mock_discovery()
    mock_jwks(access_keys)

    result = await auth.authenticate(build_request(), sign_rpt(access_keys))

    assert result.user_id == "admin_a@test.com"
    assert result.end_user_id == "tenant-a"
    assert result.metadata == {"acme_region": "euw1", "acme_tenant": "tenant-a"}
    assert result.api_key.startswith("acme-jwt-")
    assert sign_rpt(access_keys) not in result.api_key
    assert result.jwt_claims["aud"] == "client"
    assert result.user_role == "internal_user"


@respx.mock
async def test_rpt_jwks_cached_across_calls(auth, access_keys):
    mock_discovery()
    jwks_route = mock_jwks(access_keys)

    await auth.authenticate(build_request(), sign_rpt(access_keys))
    await auth.authenticate(build_request(), sign_rpt(access_keys))

    assert jwks_route.call_count == 1


@respx.mock
async def test_rpt_with_unknown_kid_rejected(auth, access_keys):
    mock_discovery()
    mock_jwks(access_keys)

    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(), sign_rpt(access_keys, kid="missing-kid"))
    assert exc_info.value.status_code == 401


@respx.mock
async def test_rpt_signed_by_rogue_key_rejected(auth, access_keys, rogue_keys):
    mock_discovery()
    mock_jwks(access_keys)

    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(), sign_rpt(rogue_keys, kid=access_keys.kid))
    assert exc_info.value.status_code == 401


@respx.mock
async def test_expired_rpt_rejected(auth, access_keys):
    mock_discovery()
    mock_jwks(access_keys)

    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(), sign_rpt(access_keys, exp=int(time.time()) - 10))
    assert exc_info.value.status_code == 401


async def test_rpt_without_permission_rejected_before_any_http(auth, access_keys):
    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(), sign_rpt(access_keys, permissions=[]))
    assert exc_info.value.status_code == 401


async def test_tenant_token_confined_to_llm_routes(auth, access_keys):
    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(path="/key/generate"), sign_rpt(access_keys))
    assert exc_info.value.status_code == 403


@respx.mock
async def test_rpt_unknown_tenant_fails_closed_400(auth, access_keys):
    respx.get(f"{DISCOVERY_API}/region/nope").respond(404)

    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(), sign_rpt(access_keys, tenant="nope"))
    assert exc_info.value.status_code == 400


@respx.mock
async def test_idp_bearer_exchanges_for_declared_tenant(auth):
    mock_discovery()
    token_route = respx.post(f"{ACCESS_API}/token").respond(200, json={"access_token": "rpt-1", "expires_in": 300})
    bearer = idp_token()
    body = {"metadata": {"tags": ["agent:e2e", "tenant:tenant-a"]}}

    result = await auth.authenticate(build_request(body=body), bearer)

    assert result.user_id == "admin_a@test.com"
    assert result.end_user_id == "tenant-a"
    assert result.metadata == {"acme_region": "euw1", "acme_tenant": "tenant-a"}
    assert token_route.calls[0].request.headers["authorization"] == f"Bearer {bearer}"


@pytest.mark.parametrize(
    "body",
    [
        {"metadata": {"tags": ["agent:e2e"]}},
        {"metadata": {"tags": ["tenant:tenant-a", "tenant:tenant-b"]}},
        {"metadata": None},
        {},
    ],
    ids=["no-tenant-tag", "two-tenant-tags", "null-metadata", "empty-body"],
)
async def test_idp_bearer_requires_exactly_one_tenant_tag(auth, body):
    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(body=body), idp_token())
    assert exc_info.value.status_code == 401


@respx.mock
async def test_idp_bearer_not_entitled_fails_closed_403(auth):
    mock_discovery()
    respx.post(f"{ACCESS_API}/token").respond(403)
    body = {"metadata": {"tags": ["tenant:tenant-a"]}}

    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(body=body), idp_token())
    assert exc_info.value.status_code == 403


@respx.mock
async def test_idp_exchange_error_fails_closed_401_without_token_leak(auth):
    mock_discovery()
    respx.post(f"{ACCESS_API}/token").respond(500)
    bearer = idp_token()
    body = {"metadata": {"tags": ["tenant:tenant-a"]}}

    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(body=body), bearer)

    assert exc_info.value.status_code == 401
    assert bearer not in str(exc_info.value.detail)


async def test_master_key_lane_returns_admin_alias(auth, proxy_state):
    proxy_state.master_key = "sk-unit-master"

    result = await auth.authenticate(build_request(), "sk-unit-master")

    assert result.api_key == "litellm_proxy_master_key"
    assert result.user_role == "proxy_admin"
    assert result.via_virtual_key is True


async def test_unknown_key_without_db_rejected(auth, proxy_state):
    proxy_state.master_key = "sk-unit-master"

    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(), "sk-not-the-master")
    assert exc_info.value.status_code == 401


@pytest.fixture
def db_key(monkeypatch, proxy_state):
    from litellm.proxy._types import UserAPIKeyAuth
    from litellm.proxy.auth import auth_checks

    proxy_state.prisma_client = object()
    key = UserAPIKeyAuth(token="hashed-key-abc", max_budget=0.004, spend=0.0)
    budget_checks = []

    async def fake_get_key_object(**kwargs):
        return key

    async def fake_budget_check(valid_token, proxy_logging_obj, user_obj=None):
        budget_checks.append(valid_token)
        if (valid_token.spend or 0.0) > (valid_token.max_budget or float("inf")):
            raise litellm.BudgetExceededError(
                current_cost=valid_token.spend, max_budget=valid_token.max_budget
            )

    monkeypatch.setattr(auth_checks, "get_key_object", fake_get_key_object)
    monkeypatch.setattr(auth_checks, "_virtual_key_max_budget_check", fake_budget_check)
    return SimpleNamespace(key=key, budget_checks=budget_checks)


async def test_db_key_gets_hash_as_api_key_for_spend_attribution(auth, db_key):
    result = await auth.authenticate(build_request(), "sk-some-db-key")

    assert result.api_key == "hashed-key-abc"
    assert db_key.budget_checks == [db_key.key]


async def test_db_key_over_budget_rejected(auth, db_key):
    db_key.key.spend = 0.02

    with pytest.raises(litellm.BudgetExceededError):
        await auth.authenticate(build_request(), "sk-some-db-key")


async def test_blocked_db_key_rejected(auth, db_key):
    db_key.key.blocked = True

    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(), "sk-some-db-key")
    assert exc_info.value.status_code == 401
    assert db_key.budget_checks == []


@respx.mock
async def test_foreign_issuer_jwt_falls_to_key_lane_without_acme_calls(auth, proxy_state):
    proxy_state.master_key = "sk-unit-master"
    foreign = forge_jwt({"aud": "account", "iss": "https://other-idp.test/realms/acme"})

    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(), foreign)
    assert exc_info.value.status_code == 401


async def test_missing_bearer_rejected(auth):
    with pytest.raises(HTTPException) as exc_info:
        await auth.authenticate(build_request(), "")
    assert exc_info.value.status_code == 401


async def test_public_route_bypasses_all_lanes(auth):
    result = await auth.authenticate(build_request(path="/health/liveliness"), "")

    assert result.user_role == "internal_user_viewer"
