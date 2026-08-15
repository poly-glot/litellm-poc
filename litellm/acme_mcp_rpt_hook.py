"""Prototype LiteLLM custom guardrail: exchange a user's Keycloak IDP token for a
tenant-scoped RPT once, at the gateway, and inject it as the upstream Authorization header.

Modelled on the shipped MCPJWTSigner (litellm/proxy/guardrails/guardrail_hooks/
mcp_jwt_signer). Centralizes the Acme IDP->RPT exchange so MCP servers stay
auth-agnostic and need no per-server auth config.

Tenancy is PATH-BASED. External MCP clients (Claude Code, Claude Desktop, claude.ai /
CoWork connectors) can only set a URL and complete OAuth — no custom headers — so the
tenant rides the URL as a per-tenant `mcp_servers` entry instead of an `x-tenant-id`
header. The entry IS the tenant: it is named for the tenant handle with dashes encoded as
underscores (`tenant-a` -> `tenant_a`, because `-` is LiteLLM's tool-prefix separator
and is banned in server names; handles never contain underscores, so the mapping is
bijective). Its URL is a plain per-server path, keyless-capable:

    /mcp/tenant_a    (also /tenant_a/mcp)

The hook reads the resolved server name from the native `mcp_server_name` hook field and
decodes the tenant from it — no raw request headers and therefore no LiteLLM patches. The
entry's `static_headers` carry `x-tenant-id` upstream for `tools/list`, which skips
guardrail hooks; this hook injects the RPT plus the tenant and region headers on
`tools/call`, the only path that reaches the tenant's upstream.

The exchange is gated by the BEARER, not by the server name — the guardrail is global
(`default_on: true`) and fires on every MCP call, so it decides for itself. Non-exchangeable
bearers PASS THROUGH untouched, which is what keeps the non-tenant servers correct:

  * Internal agentic platform — caller authenticates with a LiteLLM virtual key as the
    top-level bearer on the plain `acme_mcp` / `bci` / `search_mcp` entries and supplies the
    real upstream credential in the aliased `x-mcp-<server>-authorization` header. The key
    is not a Keycloak token, so `_is_exchangeable_idp_token` is False and the hook returns
    before any Discovery call — the aliased bearer reaches the MCP server unchanged.
  * Direct user MCP consumption — caller has no LiteLLM key (we can't mint one per user)
    and presents their raw Keycloak IDP access token as the top-level bearer on a
    per-tenant entry. The hook detects it (issuer match, audience is not the
    already-exchanged RPT audience) and runs the IDP->RPT exchange, injecting
    `Authorization: Bearer <RPT>` + `x-tenant-id` + `x-tenant-region` (the Discovery
    API's region result, so the upstream routes regionally without its own lookup)
    upstream.

An already-minted RPT (audience `client`) is also passed through — never re-exchanged.

Tenant MCP calls are RATE-limited, never spend-gated. MCP calls add no spend — the
delegate admission path is keyless and nothing downstream attributes cost — so a
monetary ceiling here could only ever consume budget the tenant's COMPLETIONS filled.
Spend budgets therefore stay on the completions seam (acme_custom_auth), where the cost
is actually booked; rate is the meaningful limit for tool traffic. LiteLLM's native
mcp_rpm_limit maps live on keys and teams and the keyless delegate path has neither, so
the limit is enforced here.

The limit resolves per tenant, most specific first: `rpm_limit` on the tenant's own
budget row, then on the `max_end_user_budget_id` default row (fetched directly via
get_default_end_user_budget so brand-new, row-less tenants are limited from their very
first call), then `default_mcp_rpm_limit` from this guardrail's own config — the floor
that keeps rate limiting in force on a gateway with no database or an unseeded budget
table. No limit at any level means unlimited. Enforcement is a fixed sixty-second window
counted per tenant in the hook's DualCache (`acme:mcp-rpm:{tenant}:{window}`,
Redis-backed in this deployment so gateway workers share buckets), increment-then-check
like ParallelRequestLimiterV3, refusing with an in-band 429 that carries
`retry_after_seconds`. `POST /budget/update` changes row limits and propagates within
the management-object cache TTL (~60s); the config floor changes on gateway restart.
Listing is never limited, mirroring the info-route exemption on the completions side.

Because the exchange gate is the bearer, the tenant servers carry no `_acme`-style server-type
marker; the name is the tenant alone. (If a future non-tenant server is ever exposed keyless
with a raw IDP token, it would need a positive opt-in the hook can read — not a name suffix —
since the hook cannot tell a non-tenant name from a tenant one by shape alone.)

Token classification, tenant extraction and the Discovery/Access HTTP cores live in
acme_tokens.py, shared verbatim with the completions authenticator (acme_custom_auth) so
the MCP and LLM seams cannot drift apart on what a bearer means.

Register once in config.yaml:

    guardrails:
      - guardrail_name: acme-mcp-rpt
        litellm_params:
          guardrail: acme_mcp_rpt_hook.AcmeMcpRptHook
          mode: pre_mcp_call
          default_on: true
          access_api_template: "https://access.api.{region}.acme.test"
          client_discovery_api: "https://client-discovery.api.acme.test"
          default_mcp_rpm_limit: 60
          oauth_issuer_template: "https://keycloak.acme.test/realms/{realm}"
          realm: acme

`oauth_issuer_template` accepts a comma-separated list when one gateway fronts several
regional issuers (for example both `/eu/realms/{realm}` and `/us/realms/{realm}` hosts);
a bearer matching any listed issuer is treated as exchangeable.

This is a spike prototype: open integration details remain before deploying; the
README's "What runs inside the gateway" section is the reference.
"""

import os
import sys
import time
from typing import Any, Dict, Optional, Union

import httpx
from fastapi import HTTPException

from litellm.caching import DualCache
from litellm.integrations.custom_guardrail import CustomGuardrail
from litellm.proxy._types import UserAPIKeyAuth
from litellm.types.utils import CallTypesLiteral

_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
if _MODULE_DIR not in sys.path:
    sys.path.insert(0, _MODULE_DIR)

from acme_tokens import (
    decode_claims,
    exchange_for_rpt,
    expected_issuers,
    is_exchangeable_idp_token,
    is_rpt_audience,
    resolve_region,
)

_MCP_CALL_TYPES = frozenset({"call_mcp_tool", "list_mcp_tools"})
_MCP_RATE_LIMIT_ROUTE = "/mcp/tools/call"
_MCP_RPM_WINDOW_SECONDS = 60
_HTTP_TIMEOUT_SECONDS = 10


class AcmeMcpRptHook(CustomGuardrail):
    def __init__(self, **kwargs: Any) -> None:
        self.realm: str = kwargs.pop("realm", "")
        self.oauth_issuer_template: str = kwargs.pop("oauth_issuer_template", "")
        self.access_api_template: str = kwargs.pop("access_api_template", "")
        self.client_discovery_api: str = kwargs.pop("client_discovery_api", "").rstrip("/")
        default_mcp_rpm_limit = kwargs.pop("default_mcp_rpm_limit", None)
        self.default_mcp_rpm_limit: Optional[int] = (
            int(default_mcp_rpm_limit) if default_mcp_rpm_limit else None
        )
        super().__init__(**kwargs)

        self._expected_issuers: frozenset[str] = expected_issuers(self.oauth_issuer_template, self.realm)

        self._http_client: Optional[httpx.AsyncClient] = None

    def _pooled_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS)
        return self._http_client

    async def async_pre_call_hook(
        self,
        user_api_key_dict: UserAPIKeyAuth,
        cache: DualCache,
        data: dict,
        call_type: CallTypesLiteral,
    ) -> Optional[Union[Exception, str, dict]]:
        if call_type not in _MCP_CALL_TYPES:
            return data

        hook_data = dict(data)

        tenant = self._extract_tenant(hook_data)
        if not tenant:
            return data

        bearer = hook_data.get("incoming_bearer_token")
        claims = decode_claims(bearer)
        if claims is None:
            return data

        bearer_is_rpt = is_rpt_audience(claims)
        bearer_is_tenant_idp = not bearer_is_rpt and claims.get("iss") in self._expected_issuers
        if not bearer_is_rpt and not bearer_is_tenant_idp:
            return data

        if call_type == "call_mcp_tool":
            await self._enforce_tenant_rate_limit(cache, tenant)

        if not bearer_is_tenant_idp:
            return data

        region = await self._resolve_region(cache, tenant)
        rpt = await self._exchange_for_rpt(cache, bearer, tenant, region)

        existing_headers: Dict[str, str] = hook_data.get("extra_headers") or {}
        hook_data["extra_headers"] = {
            **existing_headers,
            "Authorization": f"Bearer {rpt}",
            "x-tenant-id": tenant,
            "x-tenant-region": region,
        }
        return hook_data

    def _is_exchangeable_idp_token(self, bearer: str) -> bool:
        return is_exchangeable_idp_token(bearer, self._expected_issuers)

    async def _resolve_rpm_limit(self, tenant: str) -> Optional[int]:
        import litellm.proxy.proxy_server as proxy_server

        prisma_client = getattr(proxy_server, "prisma_client", None)
        if prisma_client is None:
            return self.default_mcp_rpm_limit

        from litellm.proxy.auth.auth_checks import (
            get_default_end_user_budget,
            get_end_user_object,
        )

        user_api_key_cache = getattr(proxy_server, "user_api_key_cache", None)
        end_user = await get_end_user_object(
            end_user_id=tenant,
            prisma_client=prisma_client,
            user_api_key_cache=user_api_key_cache,
            parent_otel_span=None,
            proxy_logging_obj=getattr(proxy_server, "proxy_logging_obj", None),
            route=_MCP_RATE_LIMIT_ROUTE,
        )

        budget_table = getattr(end_user, "litellm_budget_table", None)
        if budget_table is None:
            budget_table = await get_default_end_user_budget(
                prisma_client=prisma_client,
                user_api_key_cache=user_api_key_cache,
            )

        return getattr(budget_table, "rpm_limit", None) or self.default_mcp_rpm_limit

    async def _enforce_tenant_rate_limit(self, cache: DualCache, tenant: str) -> None:
        rpm_limit = await self._resolve_rpm_limit(tenant)
        if not rpm_limit:
            return

        window = int(time.time() // _MCP_RPM_WINDOW_SECONDS)
        counter_key = f"acme:mcp-rpm:{tenant}:{window}"
        count = await cache.async_increment_cache(counter_key, 1, ttl=2 * _MCP_RPM_WINDOW_SECONDS)
        if count is not None and count > rpm_limit:
            retry_after = _MCP_RPM_WINDOW_SECONDS - int(time.time() % _MCP_RPM_WINDOW_SECONDS)
            raise HTTPException(
                status_code=429,
                detail={
                    "error": f"MCP rate limit exceeded for tenant '{tenant}': {rpm_limit} tools/call per minute",
                    "retry_after_seconds": retry_after,
                },
            )

    def _extract_tenant(self, hook_data: Dict[str, Any]) -> Optional[str]:
        server_name = hook_data.get("mcp_server_name")
        if not isinstance(server_name, str) or not server_name.strip():
            return None

        return server_name.strip().replace("_", "-")

    async def _resolve_region(self, cache: DualCache, tenant: str) -> str:
        return await resolve_region(self._pooled_client(), cache, self.client_discovery_api, tenant)

    async def _exchange_for_rpt(self, cache: DualCache, idp_token: str, tenant: str, region: str) -> str:
        return await exchange_for_rpt(
            self._pooled_client(),
            cache,
            self.access_api_template,
            idp_token,
            tenant,
            region,
            log_prefix="AcmeMcpRptHook",
        )
