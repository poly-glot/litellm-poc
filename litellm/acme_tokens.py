"""Shared Acme token primitives for the gateway's two tenant seams.

Both the MCP guardrail (acme_mcp_rpt_hook.AcmeMcpRptHook, pre_mcp_call) and the
completions authenticator (acme_custom_auth, general_settings.custom_auth) must agree on
what a bearer IS — virtual key, exchangeable IDP token, or already-minted RPT — and on
how a tenant is derived and proven. This module is that single agreement: classification
predicates, tenant extraction, and the Discovery/Access HTTP cores with their caching and
fail-closed error mapping. Divergence between the two seams was the failure mode this
module removes; change semantics here and both seams move together.

Trust architecture (mirrors the README's "the Access API is the verifier"): IDP tokens
are never signature-checked at the gateway — the exchange at the Access API is the
verification, and its 403 is the entitlement decision. Claims are decoded WITHOUT
verification strictly to classify the bearer and label the principal; nothing
security-relevant may branch on unverified claims beyond selecting which verifier
(exchange or Access-JWKS check) the bearer is handed to.

Error mapping is part of the shared contract: unknown tenant -> 400, refused entitlement
-> 403, any other exchange failure -> 401 with a generic body that never contains token
material. The Access API's real status lands in the gateway log under the caller's
log_prefix (the string the README documents for `make logs-litellm`).
"""

import base64
import hashlib
import json
from typing import Any, Dict, FrozenSet, List, Optional

import httpx
from fastapi import HTTPException

from litellm._logging import verbose_proxy_logger
from litellm.caching import DualCache

RPT_AUDIENCE = "client"
RPT_PERMISSION_PREFIX = "acme.client:"
TENANT_TAG_PREFIX = "tenant:"

REGION_TTL_SECONDS = 3600
MIN_RPT_TTL_SECONDS = 30
RPT_REFRESH_RATIO = 0.8


def decode_claims(bearer: Optional[str]) -> Optional[Dict[str, Any]]:
    if not bearer:
        return None

    segments = bearer.split(".")
    if len(segments) != 3:
        return None

    try:
        padded = segments[1] + "=" * (-len(segments[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(padded))
    except Exception:
        return None

    return claims if isinstance(claims, dict) else None


def is_rpt_audience(claims: Dict[str, Any]) -> bool:
    audience = claims.get("aud")
    return audience == RPT_AUDIENCE or (isinstance(audience, (list, tuple)) and RPT_AUDIENCE in audience)


def expected_issuers(oauth_issuer_template: str, realm: str) -> FrozenSet[str]:
    return frozenset(
        template.strip().replace("{realm}", realm)
        for template in oauth_issuer_template.split(",")
        if template.strip()
    )


def is_exchangeable_idp_token(bearer: Optional[str], issuers: FrozenSet[str]) -> bool:
    claims = decode_claims(bearer)
    if claims is None or is_rpt_audience(claims):
        return False

    return claims.get("iss") in issuers


def tenant_from_rpt_claims(claims: Dict[str, Any]) -> Optional[str]:
    permissions = claims.get("permissions")
    if not isinstance(permissions, list):
        return None

    for permission in permissions:
        rsname = permission.get("rsname") if isinstance(permission, dict) else None
        if isinstance(rsname, str) and rsname.startswith(RPT_PERMISSION_PREFIX):
            handle = rsname[len(RPT_PERMISSION_PREFIX):]
            if handle:
                return handle

    return None


def single_tenant_tag(tags: Any) -> Optional[str]:
    if not isinstance(tags, list):
        return None

    handles = [
        tag[len(TENANT_TAG_PREFIX):]
        for tag in tags
        if isinstance(tag, str) and tag.startswith(TENANT_TAG_PREFIX)
    ]

    return handles[0] if len(handles) == 1 and handles[0] else None


def stable_principal_key(identity: str, tenant: str) -> str:
    digest = hashlib.sha256(f"{identity}:{tenant}".encode()).hexdigest()
    return f"acme-jwt-{digest}"


async def resolve_region(
    client: httpx.AsyncClient,
    cache: DualCache,
    client_discovery_api: str,
    tenant: str,
) -> str:
    cache_key = f"acme:region:{tenant}"
    cached = await cache.async_get_cache(cache_key)
    if cached:
        return cached

    url = f"{client_discovery_api.rstrip('/')}/region/{tenant}"
    response = await client.get(url)
    if response.status_code != 200:
        raise HTTPException(status_code=400, detail={"error": f"Unknown client handle '{tenant}'"})

    region = response.text.strip()
    if not region:
        raise HTTPException(status_code=400, detail={"error": f"Empty region for '{tenant}'"})

    await cache.async_set_cache(cache_key, region, ttl=REGION_TTL_SECONDS)
    return region


async def exchange_for_rpt(
    client: httpx.AsyncClient,
    cache: DualCache,
    access_api_template: str,
    idp_token: str,
    tenant: str,
    region: str,
    log_prefix: str = "AcmeMcpRptHook",
) -> str:
    cache_key = "acme:rpt:" + hashlib.sha256(f"{idp_token}:{tenant}".encode()).hexdigest()
    cached = await cache.async_get_cache(cache_key)
    if cached:
        return cached

    access_api = access_api_template.replace("{region}", region).rstrip("/")
    response = await client.post(
        f"{access_api}/token",
        headers={"authorization": f"Bearer {idp_token}", "content-type": "application/json"},
        json={"audience": [RPT_AUDIENCE], "permission": f"{RPT_PERMISSION_PREFIX}{tenant}"},
    )

    if response.status_code == 403:
        raise HTTPException(status_code=403, detail={"error": "Not entitled to this tenant"})
    if response.status_code != 200:
        verbose_proxy_logger.error("%s: RPT exchange failed status=%s", log_prefix, response.status_code)
        raise HTTPException(status_code=401, detail={"error": "RPT exchange failed"})

    try:
        body = response.json()
        rpt = body["access_token"]
        expires_in = int(body.get("expires_in", 300))
        if not isinstance(rpt, str) or not rpt:
            raise ValueError("access_token is not a non-empty string")
    except Exception:
        verbose_proxy_logger.error("%s: RPT exchange returned an unusable body", log_prefix)
        raise HTTPException(status_code=401, detail={"error": "RPT exchange failed"})

    ttl = max(MIN_RPT_TTL_SECONDS, int(expires_in * RPT_REFRESH_RATIO))
    await cache.async_set_cache(cache_key, rpt, ttl=ttl)
    return rpt
