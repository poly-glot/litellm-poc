#!/usr/bin/env bash
set -euo pipefail

DISCOVERY=${DISCOVERY:-http://localhost:4008}
IDENTITY=${IDENTITY:-http://localhost:4018}
ACCESS=${ACCESS:-http://localhost:4014}
ACME=${ACME:-http://localhost:4022}
BACKEND=${BACKEND:-http://localhost:4004}
FRONTEND=${FRONTEND:-http://localhost:4000}
GATEWAY=${GATEWAY:-http://localhost:4010}
MASTER_KEY=${LITELLM_MASTER_KEY:-sk-litellm-dev}

step() { printf '\n== %s\n' "$1"; }

step "T1 discovery: tenant-a region (expect eu)"
curl -si "$DISCOVERY/region/tenant-a" | sed -n '1p;$p'
step "T1 discovery: unknown handle (expect 404, empty body)"
curl -s -o /dev/null -w 'status %{http_code}, body %{size_download} bytes\n' "$DISCOVERY/region/nope"

step "T2 identity: PKCE login for admin_a (expect code, then tokens)"
VERIFIER=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' | cut -c1-64)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
REDIRECT="$FRONTEND/tenant-a/oauth2/callback"
LOCATION=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$IDENTITY/eu/oidc/authorize" \
  --data-urlencode "client_id=poc" --data-urlencode "redirect_uri=$REDIRECT" \
  --data-urlencode "state=st123" --data-urlencode "code_challenge=$CHALLENGE" \
  --data-urlencode "email=admin_a@test.com" --data-urlencode "password=123456")
CODE=$(printf '%s' "$LOCATION" | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
IDP=$(curl -s -X POST "$IDENTITY/eu/oidc/token" \
  --data-urlencode "grant_type=authorization_code" --data-urlencode "code=$CODE" \
  --data-urlencode "code_verifier=$VERIFIER" --data-urlencode "client_id=poc" \
  --data-urlencode "redirect_uri=$REDIRECT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
echo "IDP token obtained (${#IDP} chars)"

step "T3 access: mint tenant-a RPT (expect 200)"
RPT=$(curl -s -X POST "$ACCESS/token" -H "Authorization: Bearer $IDP" -H 'Content-Type: application/json' \
  -d '{"audience":["client"],"permission":"acme.client:tenant-a"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
echo "RPT obtained (${#RPT} chars)"
step "T3 access: cross-tenant mint (expect 403)"
curl -s -o /dev/null -w 'status %{http_code}\n' -X POST "$ACCESS/token" -H "Authorization: Bearer $IDP" \
  -H 'Content-Type: application/json' -d '{"audience":["client"],"permission":"acme.client:tenant-b"}'
step "T3 access: garbage bearer (expect 401)"
curl -s -o /dev/null -w 'status %{http_code}\n' -X POST "$ACCESS/token" -H "Authorization: Bearer garbage" \
  -H 'Content-Type: application/json' -d '{"audience":["client"],"permission":"acme.client:tenant-a"}'

step "T4 frontend: app shell served (expect 200 + title)"
curl -s "$FRONTEND/tenant-a" | grep -o '<title>[^<]*</title>'

step "T5 backend: /chat through the gateway (expect a reply)"
curl -s "$BACKEND/chat" -H 'Content-Type: application/json' \
  -d '{"prompt":"hello","tenant":"tenant-a"}' | head -c 200; echo

step "T6 acme REST: isolation (tenant-a list non-empty, tenant-b empty)"
curl -s -H 'x-tenant-id: tenant-a' "$ACME/projects" | python3 -c 'import json,sys; print("tenant-a:", len(json.load(sys.stdin)), "project(s)")'
curl -s -H 'x-tenant-id: tenant-b' "$ACME/projects" | python3 -c 'import json,sys; print("tenant-b:", len(json.load(sys.stdin)), "project(s)")'

step "T7 MCP direct: tools/list with RPT (expect three tools)"
curl -s "$ACME/mcp" -H "Authorization: Bearer $RPT" -H 'x-tenant-id: tenant-a' -H 'x-tenant-region: eu' \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | python3 -c 'import json,sys; print([t["name"] for t in json.load(sys.stdin)["result"]["tools"]])'
step "T7 MCP direct: tools/call tenant mismatch (expect 403)"
curl -s -o /dev/null -w 'status %{http_code}\n' "$ACME/mcp" -H "Authorization: Bearer $RPT" -H 'x-tenant-id: tenant-b' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_projects","arguments":{}}}'

step "Gateway: tagged completion on qwen3-local (expect 200)"
curl -s -o /dev/null -w 'status %{http_code}\n' "$GATEWAY/v1/chat/completions" -H "Authorization: Bearer $MASTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-local","messages":[{"role":"user","content":"hi"}],"metadata":{"tags":["agent:e2e"]}}'
step "Gateway: untagged completion (expect 400 after T8 restart)"
curl -s -o /dev/null -w 'status %{http_code}\n' "$GATEWAY/v1/chat/completions" -H "Authorization: Bearer $MASTER_KEY" \
  -H 'Content-Type: application/json' -d '{"model":"qwen3-local","messages":[{"role":"user","content":"hi"}]}'

step "Gateway JWT auth: completion with RPT bearer (expect 200)"
curl -s -o /dev/null -w 'status %{http_code}\n' "$GATEWAY/v1/chat/completions" -H "Authorization: Bearer $RPT" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-local","messages":[{"role":"user","content":"/no_think ping rpt"}],"metadata":{"tags":["agent:e2e","tenant:tenant-a"]}}'
step "Gateway JWT auth: completion with IDP bearer + tenant tag (expect 200)"
curl -s -o /dev/null -w 'status %{http_code}\n' "$GATEWAY/v1/chat/completions" -H "Authorization: Bearer $IDP" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-local","messages":[{"role":"user","content":"/no_think ping idp"}],"metadata":{"tags":["agent:e2e","tenant:tenant-a"]}}'
step "Gateway JWT auth: IDP bearer without tenant tag (expect 401)"
curl -s -o /dev/null -w 'status %{http_code}\n' "$GATEWAY/v1/chat/completions" -H "Authorization: Bearer $IDP" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-local","messages":[{"role":"user","content":"/no_think ping"}],"metadata":{"tags":["agent:e2e"]}}'
step "Gateway JWT auth: IDP bearer cross-tenant tag (expect 403)"
curl -s -o /dev/null -w 'status %{http_code}\n' "$GATEWAY/v1/chat/completions" -H "Authorization: Bearer $IDP" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-local","messages":[{"role":"user","content":"/no_think ping"}],"metadata":{"tags":["agent:e2e","tenant:tenant-b"]}}'
mcp_result() {
  python3 -c '
import json, sys
raw = sys.stdin.read().strip()
for line in raw.splitlines():
    if line.startswith("data: "):
        raw = line[6:]
        break
print(json.dumps(json.loads(raw)))
'
}

step "Gateway flow C: tools/list via gateway with IDP token (expect tenant_a-prefixed tools)"
curl -s "$GATEWAY/mcp/tenant_a" -H "Authorization: Bearer $IDP" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}' | mcp_result \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print([t["name"] for t in d["result"]["tools"]] if "result" in d else d)'

step "Gateway flow C: tools/call via gateway (IDP token in, RPT exchanged by the guardrail)"
curl -s "$GATEWAY/mcp/tenant_a" -H "Authorization: Bearer $IDP" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"tenant_a-list_projects","arguments":{}}}' | mcp_result \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d.get("result",{}); print(r.get("content",[{}])[0].get("text","")[:160] or d)'

printf '\nGateway checks assume the litellm container carries the T9 env vars (recreate via compose after changing them; see README).\n'
