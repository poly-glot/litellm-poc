"""Seam tripwires against the pinned LiteLLM image.

Both hooks ride on undocumented product internals. Each test here pins ONE seam a hook
depends on, so a LiteLLM image bump fails this suite in CI before it fails in an
environment. A failure here means: re-verify the named seam against the new image and
update the hook (or this test) deliberately — never delete a tripwire to go green.
"""

import inspect

import pytest


def test_manager_singleton_and_registry_shape():
    from litellm.proxy._experimental.mcp_server.mcp_server_manager import (
        global_mcp_server_manager,
    )

    assert isinstance(global_mcp_server_manager.config_mcp_servers, dict)
    assert isinstance(global_mcp_server_manager.registry, dict)

    merged = global_mcp_server_manager.get_registry()
    assert isinstance(merged, dict)


def test_get_mcp_server_by_name_is_sync_with_expected_signature():
    from litellm.proxy._experimental.mcp_server.mcp_server_manager import MCPServerManager

    method = MCPServerManager.get_mcp_server_by_name
    assert not inspect.iscoroutinefunction(method)

    parameters = list(inspect.signature(method).parameters)
    assert parameters[:2] == ["self", "server_name"]
    assert "client_ip" in parameters


def test_mcp_server_model_accepts_resolver_clone_fields():
    from conftest import build_template

    template = build_template()
    clone = template.model_copy(
        update={
            "server_id": "tenant-probe",
            "name": "probe",
            "alias": "probe",
            "server_name": "probe",
            "static_headers": {"x-tenant-id": "probe"},
            "mcp_info": {"server_name": "probe"},
            "short_prefix": None,
        }
    )

    assert clone.server_id == "tenant-probe"
    assert clone.alias == "probe"
    assert template.server_id != clone.server_id


def test_oauth2_delegate_admission_gate_exists():
    from litellm.proxy._experimental.mcp_server.auth.user_api_key_auth_mcp import (
        MCPRequestHandler,
    )
    from litellm.types.mcp import MCPAuth

    assert MCPAuth.oauth2.value == "oauth2"
    assert hasattr(MCPRequestHandler, "_target_servers_delegate_auth_to_upstream")

    from conftest import build_template

    template = build_template()
    assert template.auth_type == MCPAuth.oauth2
    assert template.delegate_auth_to_upstream is True


def test_guardrail_payload_carries_hook_contract_fields():
    import litellm.proxy.utils as proxy_utils

    source = inspect.getsource(proxy_utils)
    assert "mcp_rate_limit_server_name" in source
    assert '"mcp_server_name"' in source


def test_pre_call_tool_check_requires_resolved_server():
    from litellm.proxy._experimental.mcp_server.mcp_server_manager import MCPServerManager

    parameters = inspect.signature(MCPServerManager.pre_call_tool_check).parameters
    assert "server" in parameters
    assert parameters["server"].default is inspect.Parameter.empty


def test_mcp_call_types_exist():
    from litellm.types.utils import CallTypes

    assert CallTypes.call_mcp_tool.value == "call_mcp_tool"
    assert CallTypes.list_mcp_tools.value == "list_mcp_tools"


def test_completion_call_types_match_tag_hook_gate():
    from litellm.types.utils import CallTypes

    from custom_hooks import _COMPLETION_CALL_TYPES

    assert {call_type.value for call_type in CallTypes if "completion" in call_type.value} == _COMPLETION_CALL_TYPES


def test_custom_guardrail_base_instantiable_from_config_dir():
    from acme_mcp_rpt_hook import AcmeMcpRptHook
    from acme_mcp_tenant_resolver import AcmeMcpTenantResolver

    from litellm.integrations.custom_guardrail import CustomGuardrail

    assert issubclass(AcmeMcpRptHook, CustomGuardrail)
    assert issubclass(AcmeMcpTenantResolver, CustomGuardrail)


def test_custom_auth_dispatch_awaits_with_request_and_api_key_kwargs():
    from litellm.proxy.auth.user_api_key_auth import _user_api_key_auth_builder

    source = inspect.getsource(_user_api_key_auth_builder)
    assert "elif user_custom_auth is not None:" in source
    assert "await user_custom_auth(request=request, api_key=api_key)" in source
    assert "UserAPIKeyAuth.model_validate(response)" in source


def test_post_custom_auth_checks_flag_is_consumed():
    from litellm.proxy.auth import user_api_key_auth

    source = inspect.getsource(user_api_key_auth._user_api_key_auth_builder)
    assert 'getattr(litellm, "enable_post_custom_auth_checks", False)' in source
    assert inspect.iscoroutinefunction(user_api_key_auth._run_post_custom_auth_checks)


def test_public_route_gate_symbols_match_builder_usage():
    from litellm.proxy._types import LiteLLMRoutes
    from litellm.proxy.auth.auth_utils import get_request_route, route_in_additonal_public_routes
    from litellm.proxy.auth.user_api_key_auth import _route_requires_auth_despite_public

    assert "request" in inspect.signature(get_request_route).parameters
    assert list(inspect.signature(route_in_additonal_public_routes).parameters) == ["current_route"]
    assert list(inspect.signature(_route_requires_auth_despite_public).parameters) == ["route", "general_settings"]
    assert "/health/liveliness" in LiteLLMRoutes.public_routes.value


def test_master_key_mirror_symbols():
    from litellm.constants import LITELLM_PROXY_MASTER_KEY_ALIAS
    from litellm.proxy._types import LitellmUserRoles, UserAPIKeyAuth

    assert LITELLM_PROXY_MASTER_KEY_ALIAS == "litellm_proxy_master_key"
    assert LitellmUserRoles.PROXY_ADMIN is not None
    assert LitellmUserRoles.INTERNAL_USER is not None
    assert LitellmUserRoles.INTERNAL_USER_VIEW_ONLY is not None
    assert "via_virtual_key" in UserAPIKeyAuth.model_fields
    assert "jwt_claims" in UserAPIKeyAuth.model_fields


def test_get_key_object_signature_and_hash_token():
    from litellm.proxy.auth.auth_checks import get_key_object
    from litellm.proxy.utils import hash_token

    assert inspect.iscoroutinefunction(get_key_object)
    parameters = list(inspect.signature(get_key_object).parameters)
    assert parameters[:3] == ["hashed_token", "prisma_client", "user_api_key_cache"]
    assert "proxy_logging_obj" in parameters

    hashed = hash_token("sk-probe")
    assert isinstance(hashed, str) and len(hashed) == 64


def test_llm_route_check_covers_chat_completions_and_blocks_key_management():
    from litellm.proxy.auth.route_checks import RouteChecks

    assert RouteChecks.is_llm_api_route(route="/v1/chat/completions") is True
    assert RouteChecks.is_llm_api_route(route="/chat/completions") is True
    assert RouteChecks.is_llm_api_route(route="/key/generate") is False


def test_read_request_body_is_auth_safe_coroutine():
    from litellm.proxy.common_utils.http_parsing_utils import _read_request_body

    assert inspect.iscoroutinefunction(_read_request_body)
    assert "request" in inspect.signature(_read_request_body).parameters


def test_pyjwt_rs256_jwk_support_present():
    from jwt.algorithms import RSAAlgorithm

    assert hasattr(RSAAlgorithm, "from_jwk")
    assert hasattr(RSAAlgorithm, "to_jwk")


def test_custom_auth_module_loads_from_config_dir_and_arms_post_checks():
    import litellm

    from acme_custom_auth import AUTH, acme_jwt_or_key_auth

    assert inspect.iscoroutinefunction(acme_jwt_or_key_auth)
    assert list(inspect.signature(acme_jwt_or_key_auth).parameters) == ["request", "api_key"]
    assert AUTH is not None
    assert litellm.enable_post_custom_auth_checks is True


def test_get_instance_fn_execs_file_without_config_dir_on_sys_path():
    from litellm.proxy.types_utils.utils import get_instance_fn

    source = inspect.getsource(get_instance_fn)
    assert "spec_from_file_location" in source
    assert "sys.path" not in source


def test_config_relative_resolution_covers_custom_auth():
    from pathlib import Path

    import litellm

    source = (Path(litellm.__file__).parent / "proxy" / "proxy_server.py").read_text()
    assert 'general_settings.get("custom_auth", None)' in source
    assert "get_instance_fn(value=custom_auth, config_file_path=config_file_path)" in source


def test_post_custom_auth_checks_enforce_end_user_budget():
    from litellm.proxy.auth import user_api_key_auth

    source = inspect.getsource(user_api_key_auth._run_post_custom_auth_checks)
    assert "_lookup_end_user_and_apply_budget" in source
    assert "_check_end_user_budget" in source


def test_default_end_user_budget_id_applied_in_lookup():
    import litellm

    from litellm.proxy.auth import auth_checks

    assert hasattr(litellm, "max_end_user_budget_id")
    assert "_apply_default_budget_to_end_user" in inspect.getsource(auth_checks.get_end_user_object)
    assert "max_end_user_budget_id" in inspect.getsource(auth_checks.get_default_end_user_budget)


def test_end_user_budget_check_raises_budget_exceeded():
    from litellm.proxy.auth import auth_checks

    source = inspect.getsource(auth_checks._check_end_user_budget)
    assert "BudgetExceededError" in source
    assert "max_budget" in source


def test_end_user_spend_writer_upserts_tenant_rows():
    from litellm.proxy.utils import ProxyUpdateSpend

    source = inspect.getsource(ProxyUpdateSpend.update_end_user_spend)
    assert "litellm_endusertable.upsert" in source
    assert '"create"' in source
    assert '"increment"' in source


def test_auth_end_user_id_reaches_spend_metadata():
    from litellm.proxy import litellm_pre_call_utils

    source = inspect.getsource(litellm_pre_call_utils)
    assert "user_api_key_end_user_id=user_api_key_dict.end_user_id" in source


def test_end_user_budget_symbols_match_mcp_gate_usage():
    import litellm

    from litellm.proxy.auth.auth_checks import _check_end_user_budget, get_end_user_object

    assert inspect.iscoroutinefunction(get_end_user_object)
    assert inspect.iscoroutinefunction(_check_end_user_budget)
    parameters = list(inspect.signature(get_end_user_object).parameters)
    assert parameters[:3] == ["end_user_id", "prisma_client", "user_api_key_cache"]
    assert {"route", "parent_otel_span", "proxy_logging_obj"} <= set(parameters)
    assert list(inspect.signature(_check_end_user_budget).parameters) == ["end_user_obj", "route"]
    assert hasattr(litellm, "BudgetExceededError")


def test_mcp_guardrail_exception_surfaces_in_band():
    import litellm.proxy.utils as proxy_utils

    source = inspect.getsource(proxy_utils)
    assert "isinstance(llm_result, Exception)" in source
    assert "should_proceed=False" in source


def test_spend_attribution_reads_api_key_hash_field():
    from litellm.proxy import litellm_pre_call_utils

    source = inspect.getsource(litellm_pre_call_utils)
    assert "user_api_key_hash=user_api_key_dict.api_key" in source


def test_virtual_key_budget_check_matches_key_lane_usage():
    from litellm.proxy.auth.auth_checks import _virtual_key_max_budget_check

    assert inspect.iscoroutinefunction(_virtual_key_max_budget_check)
    parameters = list(inspect.signature(_virtual_key_max_budget_check).parameters)
    assert parameters[:2] == ["valid_token", "proxy_logging_obj"]
    source = inspect.getsource(_virtual_key_max_budget_check)
    assert "spend:key:" in source
    assert "max_budget" in source


def test_default_key_generate_params_fill_unset_fields():
    import litellm

    from pathlib import Path

    assert hasattr(litellm, "default_key_generate_params")
    source = (
        Path(litellm.__file__).parent / "proxy" / "management_endpoints" / "key_management_endpoints.py"
    ).read_text()
    assert "litellm.default_key_generate_params is not None" in source
    assert '"max_budget"' in source


def test_customer_and_budget_management_models_carry_budget_fields():
    from litellm.proxy._types import BudgetNewRequest, NewCustomerRequest, UpdateCustomerRequest

    assert issubclass(NewCustomerRequest, BudgetNewRequest)
    assert "max_budget" in UpdateCustomerRequest.model_fields
    assert "budget_id" in UpdateCustomerRequest.model_fields
    assert "budget_id" in BudgetNewRequest.model_fields
    assert "max_budget" in BudgetNewRequest.model_fields


def test_budget_rows_carry_rpm_limit_for_mcp_rate_gate():
    from litellm.proxy._types import BudgetNewRequest, LiteLLM_BudgetTable

    assert "rpm_limit" in BudgetNewRequest.model_fields
    assert "rpm_limit" in LiteLLM_BudgetTable.model_fields


def test_budget_repository_is_the_shared_read_write_seam():
    from litellm.proxy.auth.auth_checks import get_default_end_user_budget
    from litellm.repositories.budget_repository import BudgetRepository

    assert "BudgetRepository(prisma_client).table.find_unique" in inspect.getsource(get_default_end_user_budget)
    assert "litellm_budgettable" in inspect.getsource(BudgetRepository.table.fget)


def test_dual_cache_increment_matches_rate_gate_usage():
    from litellm.caching import DualCache

    assert inspect.iscoroutinefunction(DualCache.async_increment_cache)
    parameters = list(inspect.signature(DualCache.async_increment_cache).parameters)
    assert parameters[:3] == ["self", "key", "value"]


def test_default_end_user_budget_signature_matches_rate_gate_usage():
    from litellm.proxy.auth.auth_checks import get_default_end_user_budget

    assert inspect.iscoroutinefunction(get_default_end_user_budget)
    parameters = list(inspect.signature(get_default_end_user_budget).parameters)
    assert parameters[:2] == ["prisma_client", "user_api_key_cache"]
