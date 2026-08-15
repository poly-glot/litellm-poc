"""Shared fixtures for the Acme LiteLLM hook tests.

Runs INSIDE the pinned LiteLLM image (CI: the same image tag the gateway deploys with),
so `import litellm` resolves to the exact runtime the hooks ride on — the seam tests in
test_litellm_seams.py are only meaningful under that condition.

Layer C (tests/integration) runs black-box against a live gateway and needs no fixture
from here beyond the token forging helpers below.
"""

import base64
import json
import sys
from pathlib import Path
from types import ModuleType
from typing import Any, Dict, Optional

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))


@pytest.fixture(autouse=True)
def proxy_state(monkeypatch):
    state = ModuleType("litellm.proxy.proxy_server")
    state.general_settings = {}
    state.litellm_proxy_admin_name = "default_user_id"
    state.master_key = None
    state.premium_user = False
    state.prisma_client = None
    state.proxy_logging_obj = None
    state.user_api_key_cache = None
    monkeypatch.setitem(sys.modules, "litellm.proxy.proxy_server", state)
    return state

TEMPLATE_NAME = "tpl_acme"
DISCOVERY_API = "https://discovery.test"
ACCESS_API_TEMPLATE = "https://access.{region}.test"
ISSUER_TEMPLATE = "https://kc.test/realms/{realm}"
REALM = "acme"
ISSUER = ISSUER_TEMPLATE.replace("{realm}", REALM)


def forge_jwt(claims: Dict[str, Any]) -> str:
    def segment(payload: Dict[str, Any]) -> str:
        raw = json.dumps(payload).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return f"{segment({'alg': 'RS256', 'typ': 'JWT'})}.{segment(claims)}.signature"


def exchangeable_token(issuer: str = ISSUER, audience: Any = "account") -> str:
    return forge_jwt({"iss": issuer, "aud": audience, "sub": "user-1"})


@pytest.fixture
def hook():
    from acme_mcp_rpt_hook import AcmeMcpRptHook

    return AcmeMcpRptHook(
        realm=REALM,
        oauth_issuer_template=ISSUER_TEMPLATE,
        access_api_template=ACCESS_API_TEMPLATE,
        client_discovery_api=DISCOVERY_API,
    )


@pytest.fixture
def cache():
    from litellm.caching import DualCache

    return DualCache()


@pytest.fixture
def manager():
    from litellm.proxy._experimental.mcp_server.mcp_server_manager import (
        global_mcp_server_manager,
    )

    saved_config_servers = dict(global_mcp_server_manager.config_mcp_servers)
    saved_registry = dict(global_mcp_server_manager.registry)

    yield global_mcp_server_manager

    global_mcp_server_manager.__dict__.pop("get_mcp_server_by_name", None)
    global_mcp_server_manager.config_mcp_servers = saved_config_servers
    global_mcp_server_manager.registry = saved_registry


def build_template(name: str = TEMPLATE_NAME):
    from litellm.types.mcp import MCPAuth, MCPTransport
    from litellm.types.mcp_server.mcp_server_manager import MCPServer

    return MCPServer(
        server_id=f"{name}-id",
        name=name,
        alias=name,
        server_name=name,
        url="http://upstream.test/mcp",
        transport=MCPTransport.http,
        auth_type=MCPAuth.oauth2,
        delegate_auth_to_upstream=True,
        oauth2_flow="authorization_code",
        issuer=ISSUER,
        static_headers={"x-tenant-id": "template-placeholder"},
        mcp_info={"server_name": name},
    )


@pytest.fixture
def template(manager):
    server = build_template()
    manager.config_mcp_servers[server.server_id] = server
    return server


@pytest.fixture
def resolver(manager, template):
    from acme_mcp_tenant_resolver import AcmeMcpTenantResolver

    return AcmeMcpTenantResolver(
        template_server=TEMPLATE_NAME,
        client_discovery_api=DISCOVERY_API,
        max_minted=4,
    )


@pytest.fixture
def resolve(manager, resolver):
    def _resolve(name: str, client_ip: Optional[str] = None):
        return manager.get_mcp_server_by_name(name, client_ip=client_ip)

    return _resolve
