"""Prototype LiteLLM config-dir module: resolve UNREGISTERED MCP path segments as tenants.

Companion to acme_mcp_rpt_hook.py. That hook assumes the tenant rides the URL as a
per-tenant `mcp_servers` entry (`/mcp/tenant_a`). Registering one entry per tenant does
not scale operationally (500+ customers, entries to keep in sync on onboard/offboard),
so this module removes the registration requirement: any well-shaped, previously unknown
server name is materialized on first sight as an in-memory registry entry cloned from a
single registered TEMPLATE entry, named for the tenant.

Why this seam: LiteLLM has no wildcard server names, no catch-all server, and no custom
resolver hook — every surface (routing, keyless admission, OAuth discovery, serving) does
exact-match lookups against `manager.get_registry()`. But every entry path — the
`/{name}/mcp` 404 gate, all keyless-admission gates, the pre-emptive 401 challenge, and
all OAuth discovery handlers — resolves names through ONE method on the module singleton:
`MCPServerManager.get_mcp_server_by_name`, and each of those runs BEFORE the serving
path needs the registry entry. Patching that one bound method to mint-on-miss therefore
makes the minted entry indistinguishable from a config-registered one everywhere
downstream: admission (oauth2 + delegate -> keyless), tools/list (anonymous delegate
union scans the registry), tools/call (prefix maps rebuilt from the registry), the OAuth
facade (`/{tenant}/authorize` relays to the issuer), and the RPT guardrail (reads the
resolved `mcp_server_name` = the minted alias) — the guardrail needs NO change.

Placement rules the implementation must honor (all verified against the pinned image's source):

  * Minted entries go into `manager.config_mcp_servers`, NOT `manager.registry` — the
    periodic DB reload wholesale-replaces `self.registry` (<=30s cadence when
    `store_model_in_db` is on) and would silently drop them.
  * `get_mcp_server_by_name` is sync and runs on the event-loop thread; the
    check-then-insert has no await point, so no lock is needed.
  * The clone must rebind (not share) `static_headers` and `mcp_info`; `model_copy` is
    shallow and the template's dicts must never be mutated through a clone.
  * The clone gets a DETERMINISTIC server_id (`tenant-<handle>`) so re-minting after an
    eviction or restart keys the same cache slots (per-user token cache, semaphores,
    spend-log attribution).

Fail-closed posture: minting is optimistic (the resolver is sync and cannot await the
Discovery API), so a garbage-but-well-shaped name briefly lists tool SCHEMAS (static,
tenant-independent — no tenant data). A background validation task (held by a strong
reference until it completes, because the event loop keeps only weak references and an
unreferenced task can be garbage-collected before it runs) then asks the Discovery API
for the handle's region and EVICTS the entry on a definitive miss (a 4xx), negative-caching
the name. A 5xx or a transport failure is NOT definitive — the entry stays, because a
Discovery brownout must not blackhole live tenants for the negative-cache TTL. tools/call was never exposed: the RPT hook fails closed on unknown/unentitled
tenants regardless (Discovery 400 / Access API 403). Minted entries evict
least-recently-used: every resolve of a minted name refreshes its position, so capacity
pressure removes the stalest tenant, not merely the earliest-minted one.

Register in config.yaml alongside the RPT hook (the class is a CustomGuardrail only so
the existing config-dir loading seam instantiates it at boot; it overrides no hook
methods):

    guardrails:
      - guardrail_name: acme-mcp-tenant-resolver
        litellm_params:
          guardrail: acme_mcp_tenant_resolver.AcmeMcpTenantResolver
          mode: pre_mcp_call
          default_on: false
          template_server: tenant_a
          client_discovery_api: "https://client-discovery.api.acme.test"
          max_minted: 512

This is a spike prototype. It patches one product method on the manager singleton —
softer than a fork, but version-coupled: a bump of the LiteLLM image must re-verify the
seam (the module fails loudly at boot if the singleton or method is missing).
"""

import asyncio
import re
import time
from collections import OrderedDict
from typing import Any, Optional

import httpx

from litellm._logging import verbose_proxy_logger
from litellm.integrations.custom_guardrail import CustomGuardrail

_HANDLE_PATTERN = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")
_INSTALL_MARKER = "_acme_mint_on_miss_resolver"
_MAX_HANDLE_LENGTH = 63
_RESERVED_NAMES = frozenset({"enabled", "health", "litellm", "mcp", "sse", "toolset"})
_NEGATIVE_TTL_SECONDS = 300
_VALIDATION_TIMEOUT_SECONDS = 5


class AcmeMcpTenantResolver(CustomGuardrail):
    def __init__(self, **kwargs: Any) -> None:
        self.template_server: str = kwargs.pop("template_server", "")
        self.client_discovery_api: str = kwargs.pop("client_discovery_api", "").rstrip("/")
        self.max_minted: int = int(kwargs.pop("max_minted", 512))
        super().__init__(**kwargs)

        self._minted: "OrderedDict[str, str]" = OrderedDict()
        self._rejected: dict[str, float] = {}
        self._validation_tasks: set[asyncio.Task] = set()
        self._http_client: Optional[httpx.AsyncClient] = None
        self._install()

    def _install(self) -> None:
        from litellm.proxy._experimental.mcp_server.mcp_server_manager import (
            global_mcp_server_manager,
        )

        manager = global_mcp_server_manager
        original = manager.get_mcp_server_by_name
        if getattr(original, _INSTALL_MARKER, False):
            verbose_proxy_logger.warning(
                "AcmeMcpTenantResolver: mint-on-miss resolver already installed; skipping re-install"
            )
            return

        def resolve_or_mint(server_name: str, client_ip: Optional[str] = None):
            server = original(server_name, client_ip=client_ip)
            if server is not None:
                self._mark_recently_used(server_name)
                return server

            if not self._is_mintable(server_name):
                return None

            template = original(self.template_server)
            if template is None:
                verbose_proxy_logger.warning(
                    "AcmeMcpTenantResolver: template server '%s' not registered; cannot mint '%s'",
                    self.template_server,
                    server_name,
                )
                return None

            return self._mint(manager, template, server_name)

        setattr(resolve_or_mint, _INSTALL_MARKER, True)
        manager.get_mcp_server_by_name = resolve_or_mint
        verbose_proxy_logger.info(
            "AcmeMcpTenantResolver: installed mint-on-miss resolver (template=%s, max_minted=%d)",
            self.template_server,
            self.max_minted,
        )

    def _mark_recently_used(self, server_name: str) -> None:
        if server_name in self._minted:
            self._minted.move_to_end(server_name)

    def _is_mintable(self, server_name: str) -> bool:
        if not server_name or len(server_name) > _MAX_HANDLE_LENGTH:
            return False
        if server_name in _RESERVED_NAMES or server_name == self.template_server:
            return False
        if not _HANDLE_PATTERN.match(server_name):
            return False

        rejected_until = self._rejected.get(server_name)
        if rejected_until is not None:
            if rejected_until > time.monotonic():
                return False
            del self._rejected[server_name]
        return True

    def _mint(self, manager: Any, template: Any, server_name: str):
        tenant = server_name.replace("_", "-")
        server_id = f"tenant-{server_name}"

        clone = template.model_copy(
            update={
                "server_id": server_id,
                "name": server_name,
                "alias": server_name,
                "server_name": server_name,
                "static_headers": {"x-tenant-id": tenant},
                "mcp_info": {
                    "server_name": server_name,
                    "description": f"Dynamically minted tenant endpoint for '{tenant}' (template: {self.template_server}).",
                },
                "short_prefix": None,
            }
        )

        self._evict_over_capacity(manager)
        manager.config_mcp_servers[server_id] = clone
        self._minted[server_name] = server_id
        verbose_proxy_logger.info(
            "AcmeMcpTenantResolver: minted registry entry '%s' (server_id=%s, tenant=%s)",
            server_name,
            server_id,
            tenant,
        )

        self._schedule_validation(manager, server_name, server_id, tenant)
        return clone

    def _evict_over_capacity(self, manager: Any) -> None:
        while len(self._minted) >= self.max_minted:
            stalest_name, stalest_id = self._minted.popitem(last=False)
            manager.config_mcp_servers.pop(stalest_id, None)
            verbose_proxy_logger.info(
                "AcmeMcpTenantResolver: evicted minted entry '%s' (capacity %d reached)",
                stalest_name,
                self.max_minted,
            )

    def _schedule_validation(self, manager: Any, server_name: str, server_id: str, tenant: str) -> None:
        if not self.client_discovery_api:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return

        task = loop.create_task(self._validate_or_evict(manager, server_name, server_id, tenant))
        self._validation_tasks.add(task)
        task.add_done_callback(self._validation_tasks.discard)

    def _pooled_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(timeout=_VALIDATION_TIMEOUT_SECONDS)
        return self._http_client

    async def _validate_or_evict(self, manager: Any, server_name: str, server_id: str, tenant: str) -> None:
        url = f"{self.client_discovery_api}/region/{tenant}"
        try:
            response = await self._pooled_client().get(url)
        except Exception as exc:
            verbose_proxy_logger.warning(
                "AcmeMcpTenantResolver: Discovery validation unavailable for '%s' (%s); entry kept, calls stay fail-closed",
                tenant,
                type(exc).__name__,
            )
            return

        if response.status_code == 200 and response.text.strip():
            return

        if response.status_code >= 500:
            verbose_proxy_logger.warning(
                "AcmeMcpTenantResolver: Discovery returned %d for '%s'; entry kept, calls stay fail-closed",
                response.status_code,
                tenant,
            )
            return

        manager.config_mcp_servers.pop(server_id, None)
        self._minted.pop(server_name, None)
        if len(self._rejected) >= self.max_minted:
            self._rejected.clear()
        self._rejected[server_name] = time.monotonic() + _NEGATIVE_TTL_SECONDS
        verbose_proxy_logger.info(
            "AcmeMcpTenantResolver: evicted '%s' — Discovery returned %d for tenant '%s'",
            server_name,
            response.status_code,
            tenant,
        )
