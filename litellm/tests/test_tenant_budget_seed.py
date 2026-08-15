"""Unit tests for AcmeTenantBudgetSeed — config-declared default budget row, boot-time upsert."""

import pytest

BUDGET_ID = "acme-tenant-default"


class FakeTable:
    def __init__(self):
        self.upserts = []

    async def upsert(self, where, data):
        self.upserts.append((where, data))


@pytest.fixture
def table(monkeypatch):
    fake = FakeTable()

    class FakeRepository:
        def __init__(self, prisma_client):
            self.prisma_client = prisma_client

        @property
        def table(self):
            return fake

    from litellm.repositories import budget_repository

    monkeypatch.setattr(budget_repository, "BudgetRepository", FakeRepository)
    return fake


@pytest.fixture
def impatient(monkeypatch):
    import acme_tenant_budget_seed

    monkeypatch.setattr(acme_tenant_budget_seed, "_PRISMA_POLL_SECONDS", 0.01)
    monkeypatch.setattr(acme_tenant_budget_seed, "_PRISMA_WAIT_SECONDS", 0.05)


def build_seed(**fields):
    from acme_tenant_budget_seed import AcmeTenantBudgetSeed

    return AcmeTenantBudgetSeed(guardrail_name="acme-tenant-default-budget", **fields)


async def test_declared_fields_upserted_once_prisma_connects(table, proxy_state):
    proxy_state.prisma_client = object()

    seed = build_seed(budget_id=BUDGET_ID, max_budget=25.0, rpm_limit=60)
    await seed._seed_task

    where, data = table.upserts[0]
    assert where == {"budget_id": BUDGET_ID}
    assert data["create"] == {
        "budget_id": BUDGET_ID,
        "created_by": "config.yaml",
        "max_budget": 25.0,
        "rpm_limit": 60,
        "updated_by": "config.yaml",
    }
    assert data["update"] == {"max_budget": 25.0, "rpm_limit": 60, "updated_by": "config.yaml"}


async def test_undeclared_fields_are_left_untouched(table, proxy_state):
    proxy_state.prisma_client = object()

    seed = build_seed(budget_id=BUDGET_ID, max_budget=25.0)
    await seed._seed_task

    _, data = table.upserts[0]
    assert "rpm_limit" not in data["update"]
    assert "tpm_limit" not in data["create"]


async def test_seeding_waits_for_a_late_prisma_client(table, proxy_state, impatient):
    import asyncio

    seed = build_seed(budget_id=BUDGET_ID, max_budget=25.0)
    await asyncio.sleep(0.02)
    assert table.upserts == []

    proxy_state.prisma_client = object()
    await seed._seed_task

    assert len(table.upserts) == 1


async def test_gives_up_without_a_database(table, proxy_state, impatient):
    seed = build_seed(budget_id=BUDGET_ID, max_budget=25.0)
    await seed._seed_task

    assert table.upserts == []


async def test_upsert_failure_is_swallowed(proxy_state, monkeypatch):
    proxy_state.prisma_client = object()

    class ExplodingRepository:
        def __init__(self, prisma_client):
            pass

        @property
        def table(self):
            raise RuntimeError("database is on fire")

    from litellm.repositories import budget_repository

    monkeypatch.setattr(budget_repository, "BudgetRepository", ExplodingRepository)

    seed = build_seed(budget_id=BUDGET_ID, max_budget=25.0)
    await seed._seed_task


@pytest.mark.parametrize(
    "fields",
    [{"budget_id": BUDGET_ID}, {"max_budget": 25.0}, {}],
    ids=["no-fields", "no-budget-id", "nothing"],
)
def test_incomplete_config_schedules_nothing(fields):
    seed = build_seed(**fields)

    assert seed._seed_task is None
