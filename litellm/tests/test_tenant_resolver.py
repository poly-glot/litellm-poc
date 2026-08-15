"""Unit tests for AcmeMcpTenantResolver — mint-on-miss, clone isolation, eviction, validation, lifecycle."""

import asyncio
import gc
import time
import weakref

import httpx
import pytest
import respx

from conftest import DISCOVERY_API, TEMPLATE_NAME


@pytest.mark.parametrize(
    "name",
    ["tenant_a", "acme", "a1_b2_c3", "x" * 63],
    ids=["multi-segment", "single-word", "alphanumeric", "max-length"],
)
def test_valid_handles_are_mintable(resolver, name):
    assert resolver._is_mintable(name) is True


@pytest.mark.parametrize(
    "name",
    ["mcp", "sse", "enabled", "health", "toolset", "litellm", TEMPLATE_NAME, "Has_Upper", "has-dash", "a/b", "_leading", "trailing_", "x" * 64, ""],
)
def test_invalid_handles_are_not_mintable(resolver, name):
    assert resolver._is_mintable(name) is False


def test_registered_name_resolves_without_minting(resolve, resolver, template, manager):
    before = dict(manager.config_mcp_servers)
    assert resolve(TEMPLATE_NAME) is template
    assert manager.config_mcp_servers == before
    assert not resolver._minted


def test_unknown_valid_name_mints_registry_entry(resolve, manager, template):
    clone = resolve("tenant_b")

    assert clone is not None
    assert clone.server_id == "tenant-tenant_b"
    assert clone.name == clone.alias == clone.server_name == "tenant_b"
    assert clone.static_headers == {"x-tenant-id": "tenant-b"}
    assert clone.auth_type == template.auth_type
    assert clone.delegate_auth_to_upstream is True
    assert manager.config_mcp_servers["tenant-tenant_b"] is clone
    assert manager.get_registry()["tenant-tenant_b"] is clone


def test_second_resolve_returns_same_entry_without_reminting(resolve, resolver):
    first = resolve("tenant_b")
    second = resolve("tenant_b")
    assert first is second
    assert list(resolver._minted) == ["tenant_b"]


def test_unmintable_unknown_name_returns_none(resolve):
    assert resolve("has-dash") is None
    assert resolve("acme corp") is None


def test_clone_is_isolated_from_template(resolve, template):
    clone = resolve("tenant_b")

    clone.static_headers["x-tenant-id"] = "tampered"
    clone.mcp_info["server_name"] = "tampered"

    assert template.static_headers == {"x-tenant-id": "template-placeholder"}
    assert template.mcp_info["server_name"] == TEMPLATE_NAME


def test_deterministic_server_id_across_evict_and_remint(resolve, resolver, manager):
    first_id = resolve("tenant_b").server_id

    manager.config_mcp_servers.pop("tenant-tenant_b")
    resolver._minted.pop("tenant_b")

    assert resolve("tenant_b").server_id == first_id


def test_capacity_evicts_oldest_minted(resolve, resolver, manager):
    for index in range(4):
        resolve(f"tenant_{index}")
    resolve("tenant_overflow")

    assert "tenant_0" not in resolver._minted
    assert "tenant-tenant_0" not in manager.config_mcp_servers
    assert "tenant_overflow" in resolver._minted
    assert len(resolver._minted) == 4


def test_lru_reused_entry_survives_eviction_of_staler_one(resolve, resolver, manager):
    for index in range(4):
        resolve(f"tenant_{index}")

    resolve("tenant_0")
    resolve("tenant_overflow")

    assert "tenant_0" in resolver._minted
    assert "tenant-tenant_0" in manager.config_mcp_servers
    assert "tenant_1" not in resolver._minted
    assert "tenant-tenant_1" not in manager.config_mcp_servers


def test_second_install_skips_already_patched_method(resolver, manager):
    from acme_mcp_tenant_resolver import AcmeMcpTenantResolver

    installed = manager.get_mcp_server_by_name
    AcmeMcpTenantResolver(
        template_server=TEMPLATE_NAME,
        client_discovery_api=DISCOVERY_API,
        max_minted=4,
    )

    assert manager.get_mcp_server_by_name is installed


def test_minted_entry_survives_db_registry_replacement(resolve, manager):
    from conftest import build_template

    clone = resolve("tenant_b")

    db_row = build_template("db_row")
    manager.registry = {db_row.server_id: db_row}

    assert manager.get_registry()["tenant-tenant_b"] is clone
    assert resolve("tenant_b") is clone


def test_negative_cache_blocks_and_expires(resolver):
    resolver._rejected["burned"] = time.monotonic() + 60
    assert resolver._is_mintable("burned") is False

    resolver._rejected["burned"] = time.monotonic() - 1
    assert resolver._is_mintable("burned") is True
    assert "burned" not in resolver._rejected


@respx.mock
async def test_validation_keeps_valid_tenant(resolve, resolver, manager):
    respx.get(f"{DISCOVERY_API}/region/tenant-b").respond(200, text="euw1")

    clone = resolve("tenant_b")
    await resolver._validate_or_evict(manager, "tenant_b", clone.server_id, "tenant-b")

    assert "tenant-tenant_b" in manager.config_mcp_servers
    assert "tenant_b" not in resolver._rejected


@respx.mock
async def test_validation_evicts_and_negative_caches_unknown_tenant(resolve, resolver, manager):
    respx.get(f"{DISCOVERY_API}/region/acme-fake").respond(404)

    clone = resolve("acme_fake")
    await resolver._validate_or_evict(manager, "acme_fake", clone.server_id, "acme-fake")

    assert "tenant-acme_fake" not in manager.config_mcp_servers
    assert "acme_fake" not in resolver._minted
    assert resolver._is_mintable("acme_fake") is False


@respx.mock
async def test_validation_outage_keeps_entry(resolve, resolver, manager):
    respx.get(f"{DISCOVERY_API}/region/tenant-b").mock(side_effect=httpx.ConnectError("down"))

    clone = resolve("tenant_b")
    await resolver._validate_or_evict(manager, "tenant_b", clone.server_id, "tenant-b")

    assert "tenant-tenant_b" in manager.config_mcp_servers
    assert "tenant_b" not in resolver._rejected


@respx.mock
async def test_validation_5xx_keeps_entry_and_stays_mintable(resolve, resolver, manager):
    respx.get(f"{DISCOVERY_API}/region/tenant-b").respond(503)

    clone = resolve("tenant_b")
    await resolver._validate_or_evict(manager, "tenant_b", clone.server_id, "tenant-b")

    assert "tenant-tenant_b" in manager.config_mcp_servers
    assert "tenant_b" not in resolver._rejected
    assert resolver._is_mintable("tenant_b") is True


@respx.mock
async def test_validation_task_held_by_strong_reference_until_done(resolve, resolver, manager):
    route = respx.get(f"{DISCOVERY_API}/region/tenant-b").respond(200, text="euw1")

    resolve("tenant_b")
    assert len(resolver._validation_tasks) == 1

    task = next(iter(resolver._validation_tasks))
    task_ref = weakref.ref(task)
    del task
    gc.collect()
    assert task_ref() is not None

    await asyncio.gather(*resolver._validation_tasks)
    await asyncio.sleep(0)

    assert route.called
    assert not resolver._validation_tasks


@respx.mock
async def test_validation_reuses_pooled_client(resolve, resolver, manager):
    respx.get(f"{DISCOVERY_API}/region/tenant-b").respond(200, text="euw1")
    respx.get(f"{DISCOVERY_API}/region/tenant-c").respond(200, text="euw1")

    first = resolve("tenant_b")
    await resolver._validate_or_evict(manager, "tenant_b", first.server_id, "tenant-b")
    pooled = resolver._http_client

    second = resolve("tenant_c")
    await resolver._validate_or_evict(manager, "tenant_c", second.server_id, "tenant-c")
    await asyncio.gather(*resolver._validation_tasks)

    assert pooled is not None
    assert resolver._http_client is pooled
