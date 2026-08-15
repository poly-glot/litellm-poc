"""Seed the tenant default budget row from config.yaml instead of a POST /budget/new.

`litellm_settings.max_end_user_budget_id` is only a POINTER: LiteLLM resolves it in
get_default_end_user_budget via BudgetRepository and returns None — with a log warning and
no enforcement — when no LiteLLM_BudgetTable row carries that id. v1.96.2 has no config
section that declares the row itself; `litellm.max_end_user_budget` (the float) looks like
one but is vestigial, read once under `if ... is not None: pass` in ProxyUpdateSpend. So
without this module the default budget lives only in whoever remembers to re-POST it after
the pgdata volume is recreated, and a wiped database silently means no tenant ceiling.

This module makes config.yaml the source of truth for that row: every declared field is
UPSERT-ed at boot, so a rebuilt database converges on the configured defaults and an edit
to config.yaml lands on gateway restart. Fields the config omits are left untouched on an
existing row; per-tenant overrides live on their own rows (POST /customer/update) and are
never touched here.

The write goes through the product's own BudgetRepository accessor — the same one
get_default_end_user_budget reads through — so a schema or accessor rename cannot leave
the writer and the reader pointing at different tables.

The class is a CustomGuardrail only so the existing config-dir loading seam instantiates it
at boot with its litellm_params as kwargs (the trick acme_mcp_tenant_resolver documents);
it overrides no hook methods. Construction happens during config load, BEFORE
proxy_startup_event connects Prisma, so the write is a background task that waits for
proxy_server.prisma_client and gives up with a warning rather than blocking boot — held by
a strong reference until it completes, because the event loop keeps only weak references
to tasks.

Register in config.yaml:

    guardrails:
      - guardrail_name: acme-tenant-default-budget
        litellm_params:
          budget_id: acme-tenant-default
          default_on: false
          guardrail: acme_tenant_budget_seed.AcmeTenantBudgetSeed
          max_budget: 25.0
          mode: pre_mcp_call
          rpm_limit: 60
"""

import asyncio
from typing import Any, Dict, Optional

from litellm._logging import verbose_proxy_logger
from litellm.integrations.custom_guardrail import CustomGuardrail

_PRISMA_POLL_SECONDS = 0.5
_PRISMA_WAIT_SECONDS = 120
_SEEDED_FIELDS = ("budget_duration", "max_budget", "rpm_limit", "tpm_limit")
_SEED_ACTOR = "config.yaml"


class AcmeTenantBudgetSeed(CustomGuardrail):
    def __init__(self, **kwargs: Any) -> None:
        self.budget_id: str = kwargs.pop("budget_id", "")
        declared = {name: kwargs.pop(name, None) for name in _SEEDED_FIELDS}
        self.fields: Dict[str, Any] = {name: value for name, value in declared.items() if value is not None}
        super().__init__(**kwargs)

        self._seed_task: Optional[asyncio.Task] = None
        self._schedule_seed()

    def _schedule_seed(self) -> None:
        if not self.budget_id or not self.fields:
            verbose_proxy_logger.warning(
                "AcmeTenantBudgetSeed: nothing to seed (budget_id=%r, fields=%s)", self.budget_id, self.fields
            )
            return

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return

        self._seed_task = loop.create_task(self._seed_when_connected())

    async def _seed_when_connected(self) -> None:
        prisma_client = await self._await_prisma_client()
        if prisma_client is None:
            verbose_proxy_logger.warning(
                "AcmeTenantBudgetSeed: no database after %ds; budget '%s' not seeded",
                _PRISMA_WAIT_SECONDS,
                self.budget_id,
            )
            return

        await self._upsert(prisma_client)

    async def _await_prisma_client(self) -> Any:
        import litellm.proxy.proxy_server as proxy_server

        for _ in range(int(_PRISMA_WAIT_SECONDS / _PRISMA_POLL_SECONDS)):
            prisma_client = getattr(proxy_server, "prisma_client", None)
            if prisma_client is not None:
                return prisma_client
            await asyncio.sleep(_PRISMA_POLL_SECONDS)

        return None

    async def _upsert(self, prisma_client: Any) -> None:
        from litellm.repositories.budget_repository import BudgetRepository

        try:
            await BudgetRepository(prisma_client).table.upsert(
                where={"budget_id": self.budget_id},
                data={
                    "create": {
                        "budget_id": self.budget_id,
                        "created_by": _SEED_ACTOR,
                        "updated_by": _SEED_ACTOR,
                        **self.fields,
                    },
                    "update": {"updated_by": _SEED_ACTOR, **self.fields},
                },
            )
        except Exception as exc:
            verbose_proxy_logger.error(
                "AcmeTenantBudgetSeed: seeding budget '%s' failed (%s)", self.budget_id, type(exc).__name__
            )
            return

        verbose_proxy_logger.info(
            "AcmeTenantBudgetSeed: seeded budget '%s' from config.yaml with %s", self.budget_id, self.fields
        )
