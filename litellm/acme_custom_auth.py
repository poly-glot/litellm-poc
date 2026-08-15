"""Acme completions auth: accept tenant JWTs alongside LiteLLM virtual keys.

LiteLLM's built-in dual-mode (`enable_jwt_auth`) is enterprise-gated in v1.96.2
(user_api_key_auth.py raises "JWT Auth is an enterprise only feature"), so this module
rides the OSS seam instead: `general_settings.custom_auth`. That seam REPLACES the auth
decision wholesale — the dispatcher awaits this function and returns its result
unconditionally, with no fallback to key auth on exception (the string-return
fallthrough exists only for the enterprise custom-auth wrapper) — so every lane the
gateway needs is implemented here, in precedence order:

  1. Public routes reproduce the builder's early return (view-only identity), because
     with custom_auth registered the builder's own public-route check is never reached.
  2. An RPT bearer (audience "client") is verified locally: RS256 against the Access
     API's JWKS — the one JWKS the gateway can both reach and trust — plus expiry and
     audience. Tenant comes from the RPT's own `acme.client:<handle>` permission.
     Unlike the MCP path, nothing downstream re-verifies a completion bearer, so the
     gateway must be the verifier here.
  3. An exchangeable IDP bearer (issuer in OAUTH_ISSUER_TEMPLATE) is proven exactly the
     way the MCP guardrail proves it: Discovery for the region, then the Access API
     exchange, whose signature check IS the verification and whose 403 IS the
     entitlement decision. Completions have no tenant in the URL, so the tenant rides
     the request's mandatory tags: exactly one `tenant:<handle>` entry.
  4. Anything else is the stock key lane: master key via constant-time compare
     (returning the builder's LITELLM_PROXY_MASTER_KEY_ALIAS so the raw key never
     reaches spend logs), then DB virtual keys via auth_checks.get_key_object. The
     key lane must repair two things the builder normally does after the lookup:
     spend attribution reads `UserAPIKeyAuth.api_key` ("just the hashed token" per
     litellm_pre_call_utils), but get_key_object leaves it None because api_key is
     not a DB column — so the lane copies `token` into `api_key`, or every key's
     spend silently attributes to nothing; and the key's own max_budget is enforced
     here via the stock _virtual_key_max_budget_check (live spend:key counter with
     DB fallback), because the builder's numbered budget checks never run on the
     custom-auth path and _run_post_custom_auth_checks covers only model_max_budget.
     Blocked keys are refused. Team and internal-user budgets remain out of scope
     for this POC.

JWT principals are confined to LLM API routes (RouteChecks.is_llm_api_route): the
builder's role-based route checks do not run on the custom-auth path, and a tenant
token must never reach /key or /team management routes. Spend logs key JWT principals
by a stable hash of identity+tenant (acme_tokens.stable_principal_key), not by the
rotating token.

`litellm.enable_post_custom_auth_checks` is set at import so the proxy re-runs its
post-auth expiry/budget checks on every identity this module returns; the import
happens at config load via get_instance_fn, the same relative-to-config resolution the
hook modules use. Every internal this module touches is pinned by a tripwire in
tests/test_litellm_seams.py per the upgrade policy.

Tenant budgets ride LiteLLM's end-user (customer) machinery: `_tenant_auth` sets
`end_user_id` to the tenant handle, so spend accrues per tenant in
`LiteLLM_EndUserTable` (the spend writer upserts the row on the tenant's first costed
request) and `_run_post_custom_auth_checks` enforces the budget via
`_check_end_user_budget` on every subsequent call. The default budget is the
`LiteLLM_BudgetTable` row named by `litellm_settings.max_end_user_budget_id`
(config.yaml points it at `acme-tenant-default`; seed the row once with
`POST /budget/new`), applied automatically to any tenant without an explicit
`budget_id`. Per-tenant overrides go through `POST /customer/update` with `max_budget`
or `budget_id` — all OSS management endpoints; see the README's "Tenant budgets"
section for the operating commands and cache-lag caveats.

Register in config.yaml:

    general_settings:
      custom_auth: acme_custom_auth.acme_jwt_or_key_auth
"""

import json
import os
import secrets
import sys
from typing import Any, Dict, Optional

import httpx
import jwt as pyjwt
from fastapi import HTTPException, Request

import litellm
from litellm.caching import DualCache
from litellm.constants import LITELLM_PROXY_MASTER_KEY_ALIAS
from litellm.proxy._types import LiteLLMRoutes, LitellmUserRoles, UserAPIKeyAuth
from litellm.proxy.auth.auth_utils import get_request_route, route_in_additonal_public_routes
from litellm.proxy.auth.route_checks import RouteChecks
from litellm.proxy.auth.user_api_key_auth import _route_requires_auth_despite_public
from litellm.proxy.common_utils.http_parsing_utils import _read_request_body

_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
if _MODULE_DIR not in sys.path:
    sys.path.insert(0, _MODULE_DIR)

from acme_tokens import (
    RPT_AUDIENCE,
    decode_claims,
    exchange_for_rpt,
    expected_issuers,
    is_rpt_audience,
    resolve_region,
    single_tenant_tag,
    stable_principal_key,
    tenant_from_rpt_claims,
)

litellm.enable_post_custom_auth_checks = True

_HTTP_TIMEOUT_SECONDS = 10
_JWKS_TTL_SECONDS = 300
_LOG_PREFIX = "AcmeCompletionAuth"


def _proxy_server():
    import litellm.proxy.proxy_server as proxy_server

    return proxy_server


class AcmeCompletionAuth:
    def __init__(
        self,
        access_api_template: str,
        client_discovery_api: str,
        oauth_issuer_template: str,
        realm: str,
    ) -> None:
        self.access_api_template = access_api_template
        self.client_discovery_api = client_discovery_api.rstrip("/")
        self._expected_issuers = expected_issuers(oauth_issuer_template, realm)
        self._cache = DualCache()
        self._http_client: Optional[httpx.AsyncClient] = None

    def _pooled_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS)
        return self._http_client

    async def authenticate(self, request: Request, api_key: str) -> UserAPIKeyAuth:
        route = get_request_route(request=request)
        if self._is_public_route(route):
            return UserAPIKeyAuth(user_role=LitellmUserRoles.INTERNAL_USER_VIEW_ONLY)

        bearer = (api_key or "").strip()
        claims = decode_claims(bearer)

        if claims is not None and is_rpt_audience(claims):
            return await self._authenticate_rpt(route, bearer, claims)

        if claims is not None and claims.get("iss") in self._expected_issuers:
            return await self._authenticate_idp(route, request, bearer, claims)

        return await self._default_key_auth(bearer)

    def _is_public_route(self, route: str) -> bool:
        general_settings = getattr(_proxy_server(), "general_settings", {})

        if _route_requires_auth_despite_public(route=route, general_settings=general_settings):
            return False

        return route in LiteLLMRoutes.public_routes.value or route_in_additonal_public_routes(current_route=route)

    def _require_llm_route(self, route: str) -> None:
        if not RouteChecks.is_llm_api_route(route=route):
            raise HTTPException(status_code=403, detail={"error": "Tenant tokens may only call LLM API routes"})

    async def _authenticate_rpt(self, route: str, bearer: str, claims: Dict[str, Any]) -> UserAPIKeyAuth:
        self._require_llm_route(route)

        tenant = tenant_from_rpt_claims(claims)
        if not tenant:
            raise HTTPException(status_code=401, detail={"error": "RPT carries no acme.client permission"})

        region = await resolve_region(self._pooled_client(), self._cache, self.client_discovery_api, tenant)
        verified_claims = await self._verify_rpt(bearer, region)

        identity = verified_claims.get("sub")
        if not isinstance(identity, str) or not identity:
            raise HTTPException(status_code=401, detail={"error": "RPT carries no subject"})

        return self._tenant_auth(identity, tenant, region, verified_claims)

    async def _authenticate_idp(
        self,
        route: str,
        request: Request,
        bearer: str,
        claims: Dict[str, Any],
    ) -> UserAPIKeyAuth:
        self._require_llm_route(route)

        body = await _read_request_body(request)
        metadata = body.get("metadata")
        tags = metadata.get("tags") if isinstance(metadata, dict) else None
        tenant = single_tenant_tag(tags)
        if not tenant:
            raise HTTPException(
                status_code=401,
                detail={"error": "IDP-token completions require exactly one tenant:<handle> tag"},
            )

        region = await resolve_region(self._pooled_client(), self._cache, self.client_discovery_api, tenant)
        await exchange_for_rpt(
            self._pooled_client(),
            self._cache,
            self.access_api_template,
            bearer,
            tenant,
            region,
            log_prefix=_LOG_PREFIX,
        )

        identity = claims.get("email") or claims.get("preferred_username") or claims.get("sub")
        if not isinstance(identity, str) or not identity:
            raise HTTPException(status_code=401, detail={"error": "IDP token carries no identity claim"})

        return self._tenant_auth(identity, tenant, region, claims)

    async def _verify_rpt(self, bearer: str, region: str) -> Dict[str, Any]:
        jwks = await self._access_jwks(region)

        try:
            kid = pyjwt.get_unverified_header(bearer).get("kid")
        except pyjwt.PyJWTError:
            raise HTTPException(status_code=401, detail={"error": "Unverifiable tenant token"})

        jwk = next((key for key in jwks.get("keys", []) if key.get("kid") == kid), None)
        if jwk is None:
            raise HTTPException(status_code=401, detail={"error": "Unverifiable tenant token"})

        try:
            signing_key = pyjwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(jwk))
            return pyjwt.decode(
                bearer,
                key=signing_key,
                algorithms=["RS256"],
                audience=RPT_AUDIENCE,
                options={"verify_iss": False},
            )
        except pyjwt.PyJWTError:
            raise HTTPException(status_code=401, detail={"error": "Unverifiable tenant token"})

    async def _access_jwks(self, region: str) -> Dict[str, Any]:
        cache_key = f"acme:jwks:{region}"
        cached = await self._cache.async_get_cache(cache_key)
        if cached:
            return cached

        access_api = self.access_api_template.replace("{region}", region).rstrip("/")
        response = await self._pooled_client().get(f"{access_api}/.well-known/jwks.json")
        if response.status_code != 200:
            raise HTTPException(status_code=401, detail={"error": "Access JWKS unavailable"})

        jwks = response.json()
        await self._cache.async_set_cache(cache_key, jwks, ttl=_JWKS_TTL_SECONDS)
        return jwks

    def _tenant_auth(
        self,
        identity: str,
        tenant: str,
        region: str,
        claims: Dict[str, Any],
    ) -> UserAPIKeyAuth:
        return UserAPIKeyAuth(
            api_key=stable_principal_key(identity, tenant),
            end_user_id=tenant,
            jwt_claims=claims,
            metadata={"acme_region": region, "acme_tenant": tenant},
            user_id=identity,
            user_role=LitellmUserRoles.INTERNAL_USER,
        )

    async def _default_key_auth(self, bearer: str) -> UserAPIKeyAuth:
        proxy_server = _proxy_server()

        if not bearer:
            raise HTTPException(status_code=401, detail={"error": "Missing bearer token"})

        master_key = getattr(proxy_server, "master_key", None)
        if isinstance(master_key, str):
            try:
                master_key_matches = secrets.compare_digest(bearer, master_key)
            except Exception:
                master_key_matches = False
            if master_key_matches:
                admin = UserAPIKeyAuth(
                    api_key=LITELLM_PROXY_MASTER_KEY_ALIAS,
                    user_id=getattr(proxy_server, "litellm_proxy_admin_name", None),
                    user_role=LitellmUserRoles.PROXY_ADMIN,
                )
                admin.via_virtual_key = True
                return admin

        prisma_client = getattr(proxy_server, "prisma_client", None)
        if prisma_client is None:
            raise HTTPException(status_code=401, detail={"error": "Invalid proxy server token passed"})

        from litellm.proxy.auth.auth_checks import _virtual_key_max_budget_check, get_key_object
        from litellm.proxy.utils import hash_token

        try:
            key = await get_key_object(
                hashed_token=hash_token(bearer),
                prisma_client=prisma_client,
                user_api_key_cache=getattr(proxy_server, "user_api_key_cache", None),
                proxy_logging_obj=getattr(proxy_server, "proxy_logging_obj", None),
            )
        except Exception:
            raise HTTPException(status_code=401, detail={"error": "Invalid proxy server token passed"})

        key.api_key = key.token
        if key.blocked is True:
            raise HTTPException(status_code=401, detail={"error": "Key is blocked"})

        await _virtual_key_max_budget_check(
            valid_token=key,
            proxy_logging_obj=getattr(proxy_server, "proxy_logging_obj", None),
        )
        return key


AUTH = AcmeCompletionAuth(
    access_api_template=os.environ.get("ACCESS_API_TEMPLATE", "http://dev:4014"),
    client_discovery_api=os.environ.get("DISCOVERY_API_URL", "http://dev:4008"),
    oauth_issuer_template=os.environ.get("OAUTH_ISSUER_TEMPLATE", ""),
    realm=os.environ.get("ACME_REALM", "acme"),
)


async def acme_jwt_or_key_auth(request: Request, api_key: str) -> UserAPIKeyAuth:
    return await AUTH.authenticate(request, api_key)
