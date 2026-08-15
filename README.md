# litellm-poc

LiteLLM gateway POC with custom hooks (`litellm/`) and a TypeScript monorepo (`services/`, `packages/`). This README
holds the intent, the architecture and the operating instructions. Written against LiteLLM 1.96.2.

## Why this proof of concept exists

Acme is a multi-tenant SaaS product; the name, like every `acme.test` host in the configuration, is a fictional
placeholder, because this repository is public. We want to expose AI capability, both LLM completions and MCP (Model
Context Protocol) tools, to three kinds of consumer: our own product services, our internal agent platform, and our
customers' external MCP clients such as Claude Desktop and the claude.ai connector gallery. Each consumer must act
within exactly one tenant, in that tenant's home region, with that tenant's entitlements, and every request must be
attributable for cost and audit.

The proof of concept tests whether a single LiteLLM gateway can enforce all of that at one choke point, so that the MCP
servers behind it stay authentication-agnostic and carry no per-tenant configuration of their own. External MCP clients
force the design. They accept a URL and can complete an OAuth login, and nothing else: no custom headers, no per-user
API keys. The tenant therefore has to ride the URL, and the token work has to happen inside the gateway.

The second question the POC answers is operational. Can we add this behaviour without forking LiteLLM? Everything we add
is configuration plus Python modules mounted into the stock container image. One module patches a single internal
method, a decision taken knowingly and fenced with tests (see the upgrade policy below). If a LiteLLM upgrade would
break us, the test suite must say so in CI before an environment does.

## What the POC proves

The proof of concept succeeds when all of the following hold; the test suite and the recorded transcript under
"External MCP clients" demonstrate each one.

1. A customer connects an MCP client that accepts only a URL and an OAuth login to `http://localhost:4010/mcp/<tenant>`,
   signs in through our identity service, and calls tenant-scoped tools.
2. Every `tools/call` that reaches an MCP server carries a requesting-party token (RPT) scoped to one tenant, plus
   `x-tenant-id` and `x-tenant-region` headers, all injected by the gateway.
3. A signed-in user without entitlement to a tenant receives a 403 through that tenant's URL. A tenant that does not
   exist yields an error, and no request reaches any upstream service.
4. Onboarding the five-hundredth tenant requires no change to gateway configuration. Unknown tenant names materialise on
   first use and are checked against the discovery service.
5. The internal agent platform keeps calling the same gateway with LiteLLM virtual keys, and its per-server MCP
   credentials pass through the gateway untouched.
6. Completion traffic carries attribution tags (`agent:`, `mcp:`, `tenant:`), enforced with a 400 response at the
   gateway.
7. A LiteLLM version bump either passes the full test suite or fails loudly in CI, following the upgrade policy below.

## The service landscape

The POC comprises seven services plus the gateway's own state stores. The diagram shows the interactions at a glance
(source in `diagrams/01-service-overview.mmd`; regenerate with `scripts/render-diagram.sh`, which renders Mermaid and
then straightens the frontend-to-Discovery lane from the rendered geometry, since Mermaid's ELK renderer offers no
per-edge routing control); the table below is the canonical port plan.

![High-level service overview](diagrams/01-service-overview.svg)

| Host port | Service                           | In-network address |
| --------- | --------------------------------- | ------------------ |
| 4000      | Main App frontend                 | `dev:4000`         |
| 4004      | Main App backend (BFF)            | `dev:4004`         |
| 4008      | Tenant Region Discovery Service   | `dev:4008`         |
| 4010      | LiteLLM gateway                   | `litellm:4000`     |
| 4014      | Authorization Server (Access API) | `dev:4014`         |
| 4018      | Identity Server (OIDC)            | `dev:4018`         |
| 4022      | Acme REST service + MCP server    | `dev:4022`         |
| 3100/3200 | Mock MCP servers                  | `dev:3100/3200`    |
| 5433      | Postgres (gateway state)          | `postgres:5432`    |
| none      | Redis (gateway cache)             | `redis:6379`       |
| none      | Ollama (local completion model)   | `ollama:11434`     |

All host ports are published on 127.0.0.1. All application services except the gateway run inside the dev container,
which the compose network knows as `dev`. The gateway container is `litellm` and listens on its own port 4000, published
to the host as 4010; inside the compose network it is `http://litellm:4000`, exported as `GATEWAY_URL` in the dev
container. The 3100/3200 ports serve the scratch servers behind the `bci` and `search_mcp` gateway entries. Postgres is
published on host port 5433 for inspecting the gateway's own state; its data lives in the `pgdata` volume and survives
`make down`.

Test fixtures, used by every service that holds state:

| Tenant handle | Region | Administrator                 |
| ------------- | ------ | ----------------------------- |
| `tenant-a`    | eu     | `admin_a@test.com` / `123456` |
| `tenant-b`    | us     | `admin_b@test.com` / `123456` |
| `tenant-c`    | eu     | `admin_c@test.com` / `123456` |

The gateway's tests and its registered template entry use the same fixtures, so one table serves the whole stack. In the
TypeScript workspace the table has one source, `FIXTURE_USERS` in `@litellm-poc/core`, from which the entitlement and
region maps derive.

## Vocabulary and conventions

**Tenant handle.** Lowercase letters, digits and hyphens, for example `tenant-a`. Handles never contain underscores.

**MCP server name.** The tenant handle with hyphens replaced by underscores, for example `tenant_a`. LiteLLM joins a
server prefix to a tool name with a hyphen and rejects hyphens inside server names, and because handles never contain
underscores the two forms convert in both directions without loss. The gateway decodes the tenant from the server name
and from nothing else.

**IDP token.** The access token issued by the Identity Server: a Keycloak-shaped RS256 JWT whose issuer is
`http://localhost:4018/<region>/realms/acme`.

**RPT (requesting-party token).** The tenant-scoped token the Access API mints from an IDP token. Its audience is
`client` and it carries a `permissions` array naming the tenant's resources and scopes. The term comes from User-Managed
Access.

**Tags.** Completion requests carry `metadata.tags`, and each entry must be prefixed `agent:`, `mcp:` or `tenant:` (for
example `agent:main-app`). The gateway rejects a missing, empty or malformed tag list on completion requests with HTTP
400 (details under the smoke test).

**Virtual key.** A LiteLLM-issued API key (`sk-...`) used by internal services to authenticate to the gateway. In
development the master key `sk-litellm-dev` (environment variable `LITELLM_MASTER_KEY`) stands in for per-service keys.

**Edit-and-restart rule.** The `litellm/` directory is mounted into the gateway container at `/etc/litellm`. After
editing `config.yaml` or any hook module, restart the gateway container (commands under "Local platform services"). No
image rebuild is needed.

**Version rule.** The gateway image and the dev container's Python environment must run the same LiteLLM version, 1.96.2
at the time of writing, because the seam tests described in the upgrade policy are only meaningful against the exact
runtime the gateway deploys.

## The three token flows

### Flow A: a user signs in to the Main App

1. The user visits `http://localhost:4000/tenant-a`. The frontend reads the tenant handle from the first path segment.
2. The frontend asks the Discovery service for the tenant's region: `GET http://localhost:4008/region/tenant-a` returns
   `eu` or `us` as plain text. It caches the answer in `localStorage` so that repeat visits skip the call.
3. The frontend redirects the browser to the regional Identity Server:
   `http://localhost:4018/eu/oidc/authorize?client_id=poc&response_type=code&redirect_uri=http://localhost:4000/tenant-a/oauth2/callback&scope=openid&state=<state>&code_challenge=<challenge>&code_challenge_method=S256`.
4. The user signs in on the Identity Server's login form and is redirected back to the Main App with an authorisation
   code.
5. The frontend exchanges the code, together with its PKCE verifier, for an IDP access token and a refresh token, and
   stores both in the browser.
6. The frontend exchanges the IDP token for an RPT: `POST http://localhost:4014/token` with header
   `Authorization: Bearer <IDP token>` and body `{"audience":["client"],"permission":"acme.client:tenant-a"}`. The RPT
   is short-lived (about five minutes) and is stored in the browser.
7. When the RPT expires, the frontend refreshes the IDP token using the refresh token, then mints a new RPT. The user
   sees nothing.

### Flow B: an internal agent calls the gateway

Internal services authenticate to the gateway with a virtual key and send completion requests carrying tags. For MCP
work they call the shared server entries (`acme_mcp`, `bci`, `search_mcp`) and supply the real upstream credential in
the aliased header `x-mcp-<server>-authorization`, which LiteLLM forwards to that server alone. The RPT guardrail
inspects the top-level bearer on every MCP call, finds a virtual key rather than a Keycloak JWT, and steps aside, so
this path behaves exactly as stock LiteLLM.

### Flow C: a customer's MCP client calls a tenant URL

1. The client is configured with `http://localhost:4010/mcp/tenant_a` (LiteLLM also accepts `/tenant_a/mcp`) and knows
   nothing else about us. The URL segment is the server name, so the handle's hyphen appears as an underscore.
2. The gateway resolves the server name `tenant_a`. If no entry is registered under that name, the tenant resolver
   checks the name's shape (lowercase, digits, underscores, at most 63 characters, not a reserved word), clones the
   registered template entry into an in-memory registry entry named for the tenant, and starts a background check
   against the Discovery service. A name Discovery does not recognise is evicted and refused for the next five minutes.
3. A request without credentials receives 401 with a `WWW-Authenticate` challenge pointing at
   `/.well-known/oauth-protected-resource/mcp/tenant_a`. The client reads the OAuth metadata there and completes an
   authorisation-code flow against the identity issuer, relayed through the gateway (walk-through under "External MCP
   clients").
4. `tools/list` returns the tenant's tools, each name prefixed `tenant_a-`. On the pinned LiteLLM version this path does
   not run pre-call guardrails, so the entry's static `x-tenant-id` header covers it; tool schemas are static and
   tenant-independent, so nothing tenant-confidential is exposed.
5. On `tools/call` the RPT guardrail reads the resolved server name, decodes the tenant handle, and confirms the bearer
   is an exchangeable IDP token (the issuer matches our realm and the audience is not already `client`). It resolves the
   tenant's region (cached for one hour), exchanges the IDP token at the regional Access API (result cached until 80 per
   cent of the token's lifetime), and forwards the call upstream with `Authorization: Bearer <RPT>`, `x-tenant-id` and
   `x-tenant-region`.
6. Failure paths are closed: an unknown tenant returns 400, a refused entitlement returns 403, and any other exchange
   failure returns 401 with no token material in the error body. A bearer that is already an RPT passes through and is
   never exchanged again.

## What runs inside the gateway

Five Python modules live in `litellm/` and are mounted into the gateway at `/etc/litellm`, next to `config.yaml`, which
references them by module path. LiteLLM resolves those references relative to the config directory, which is why the
modules must stay beside the file. The loaders exec each module by file path without putting the directory on
`sys.path`, so modules importing the shared `acme_tokens` sibling self-insert their own directory first.

| Module                        | Registered as                                       | LiteLLM surface used                                                                                      | Upgrade risk    |
| ----------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------- |
| `custom_hooks.py`             | `litellm_settings.callbacks`                        | `CustomLogger.async_pre_call_hook` (documented, public)                                                   | Low             |
| `acme_tokens.py`              | Not registered (shared library)                     | None directly; imported by the two Acme auth seams                                                        | Low             |
| `acme_mcp_rpt_hook.py`        | Guardrail, `mode: pre_mcp_call`, `default_on: true` | `CustomGuardrail` pre-call hook plus the MCP payload fields `mcp_server_name` and `incoming_bearer_token` | Medium          |
| `acme_custom_auth.py`         | `general_settings.custom_auth`                      | OSS custom-auth dispatch, public-route gate, master-key mirror, `get_key_object`                          | Medium          |
| `acme_mcp_tenant_resolver.py` | Guardrail entry (used only as a boot-time loader)   | Patches `MCPServerManager.get_mcp_server_by_name` on the module singleton                                 | High, by choice |

**`TagValidationHook`** validates `metadata.tags` on completion requests and rejects any tag that does not start with
`agent:`, `mcp:` or `tenant:` with HTTP 400. It runs on a documented callback surface and should survive upgrades
untouched.

**`AcmeMcpRptHook`** performs the IDP-to-RPT exchange described in flow C. The gate is the bearer, not the server name:
the guardrail runs on every MCP call, and any bearer that is not a Keycloak JWT from our realm passes through untouched,
which is what keeps flow B unchanged. It reads the bearer's claims without verifying the signature; the Access API is
the verifier, so a forged token costs one refused exchange and never reaches an upstream; a gateway-side JWKS pre-check
was weighed and rejected for exactly that reason. It fails closed on unknown tenants, refused entitlements and exchange
errors, and its error bodies never contain token material.

**`acme_custom_auth`** lets `/v1/chat/completions` accept tenant JWTs alongside virtual keys. LiteLLM's own dual-mode
(`enable_jwt_auth`) is enterprise-licensed, so the module rides the OSS `custom_auth` seam, which replaces the auth
decision wholesale; it therefore implements every lane itself, in order: public routes (mirroring the builder's early
return), RPT bearers (verified locally against the Access API's JWKS — for completions nothing downstream re-verifies
the bearer, so the gateway must, and the tenant comes from the RPT's own `acme.client:` permission), exchangeable IDP
bearers (proven the same way the MCP guardrail proves them — Discovery then the Access exchange, with the tenant
declared as the request's single `tenant:` tag), and finally the stock key lane (master key behind a constant-time
compare returning LiteLLM's spend-log alias, then database keys via `get_key_object`). Token classification, tenant
extraction and the Discovery/Access HTTP cores are shared with `AcmeMcpRptHook` through `acme_tokens.py`, so the MCP
and LLM seams cannot drift apart; JWT principals are confined to LLM API routes and are logged under a stable
identity+tenant hash, never the rotating token. Every internal it touches is pinned in `tests/test_litellm_seams.py`.

**Tenant budgets.** A tenant discovered through a JWT is also a LiteLLM customer: `acme_custom_auth` sets
`end_user_id` to the tenant handle, and everything downstream is stock OSS machinery. Spend accrues per tenant in
`LiteLLM_EndUserTable` — the spend writer upserts the row on the tenant's first costed request, so onboarding needs no
registration — and the post-custom-auth checks enforce the budget on every call, returning HTTP 429 with
`type: budget_exceeded` and the spend and budget in the message once spend passes the limit. `qwen3-local` carries
synthetic prices in `config.yaml` (`input_cost_per_token` / `output_cost_per_token`) so local completions cost real,
inspectable dollars. The default budget is the `LiteLLM_BudgetTable` row named by
`litellm_settings.max_end_user_budget_id` (`acme-tenant-default`), applied at auth time to every tenant without an
explicit `budget_id`.

That row is declared in `config.yaml`, not POSTed: the `acme-tenant-default-budget` guardrail entry
(`acme_tenant_budget_seed.AcmeTenantBudgetSeed`) upserts it at boot from its own `litellm_params`, so a recreated
`pgdata` volume converges on the configured defaults and an edit to `config.yaml` lands on the next gateway restart.
`max_end_user_budget_id` alone is only a pointer — LiteLLM has no config section that declares the row, and
`litellm.max_end_user_budget` (the float) is vestigial in 1.96.2, read once under `if ... is not None: pass`. Fields
the entry omits are left untouched on an existing row, and per-tenant rows are never touched.

**Tenant MCP rate limits.** MCP tool calls are rate-limited, never spend-gated. They add no spend of their own — the
delegate admission path is keyless, so nothing downstream attributes cost — which means a monetary ceiling there could
only consume budget the tenant's completions filled; spend budgets stay on the completions seam where the cost is
booked. LiteLLM's native `mcp_rpm_limit` maps live on keys and teams and the keyless delegate path has neither, so
`AcmeMcpRptHook` enforces the limit itself, resolving it most-specific-first: `rpm_limit` on the tenant's own budget
row, then on `acme-tenant-default`, then `default_mcp_rpm_limit` from the guardrail's own config — the floor that keeps
rate limiting in force even on a gateway with no database or an unseeded budget table. Enforcement is a fixed
sixty-second window per tenant counted in the gateway's Redis-backed cache, so workers share buckets; the request over
the quota is refused in-band with a 429 carrying `retry_after_seconds`, `tools/list` is never counted, and completions
are untouched (their rate limits remain LiteLLM's native per-key machinery). A brand-new tenant with no customer row is
limited from its very first call. Row limits change with `POST /budget/update` and propagate within the ~60-second
cache TTL; the config floor changes on gateway restart.

Inspect a tenant with `GET /customer/info?end_user_id=tenant-a` (404 until the first costed request creates the row;
the row's stored spend lands within the roughly ten-second batch write, but enforcement does not wait for it — a live
`spend:end_user:` counter registers each response cost immediately, so the request after an overrun is already
rejected). Override one tenant with `POST /customer/update` and `{"user_id": "tenant-a", "max_budget": 50}`, which
mints that tenant a dedicated budget row; the update endpoint does not invalidate the gateway's cached end-user
object, so a changed budget takes effect within about a minute (the management-object cache TTL) or immediately after
a gateway restart. `/customer/list` and `/spend/logs` give the fleet view. All of these are OSS management endpoints
callable with the master key.

Two enforcement boundaries are inherent to the pre-call check and worth knowing. Budgets trail spend by exactly one
request: the check compares recorded spend against the limit before the call, so even a tenant registered with a
near-zero budget completes its first request and is blocked from the second. And concurrent requests widen that
window: the live counter increments only when a response completes, so N parallel requests admitted together can all
land their costs past the limit — measured here, three parallel completions against a one-request headroom closed at
3.6 times the budget. The exposure is bounded by in-flight concurrency times the largest single-request cost.

Virtual keys carry budgets through the same custom-auth path: the key lane copies the token hash into the field spend
attribution reads and enforces `max_budget` with LiteLLM's stock virtual-key check (blocked keys are refused), so an
over-budget key is rejected on completions and at MCP admission alike with `Budget has been exceeded!`. New keys
inherit defaults from `litellm_settings.default_key_generate_params` in `config.yaml` (this POC sets
`max_budget: 5.0`, so every `/key/generate` without an explicit budget gets a $5 cap); `upperbound_key_generate_params`
can add ceilings. A static API key cannot be declared in `config.yaml` — the master key is the only config-defined
credential, and virtual keys are database rows minted via `/key/generate`.

**`AcmeMcpTenantResolver`** removes the need to register one gateway entry per tenant. LiteLLM has no wildcard server
names and no resolver hook, but every admission, routing and OAuth-discovery path resolves names through one method on
one singleton. The module wraps that method: an unknown but well-shaped name is materialised as a clone of the template
entry (`tenant_a`), validated against Discovery in the background, and evicted with a negative cache on a definitive
miss. Minted entries live in `config_mcp_servers` rather than the database-backed registry so that the periodic registry
reload cannot drop them, carry deterministic server ids (`tenant-<name>`) so that re-minting after a restart lands in
the same cache slots, and never share mutable state with the template. Its minted and negative caches are per-process,
so under several gateway workers each mints independently; the deterministic server ids keep that correct. The class
registers as a guardrail purely so that LiteLLM's config-directory loading instantiates it at boot; it overrides no hook
methods.

### A rejected alternative: path-rewriting middleware

We considered replacing the mint-on-miss resolver with an ASGI middleware on the proxy application: match
`/tenant/<handle>/...` in the request path, rewrite the scope path so stock LiteLLM routes serve the request, inject an
`x-tenant-id` header, and lift a bearer token from a `?key=` query parameter. We verified the assessment against the
pinned 1.96.2 source (and, for the history claim, the upstream repository) in August 2026 and rejected the idea on five
grounds.

1. **It cannot load.** LiteLLM imports config-directory modules inside the startup lifespan (`proxy_config.load_config`
   calls `init_guardrails_v2`), and by that point Starlette has built the application's middleware stack, so
   `app.add_middleware` raises `RuntimeError: Cannot add middleware after an application has started` and the proxy
   fails at boot. Installing middleware would mean abandoning the `litellm` entrypoint for a bespoke uvicorn wrapper, a
   heavier fork than the one patched method.
2. **It rewrites to routes that do not exist.** The pinned version's MCP sub-application mounts `/`, `/mcp`,
   `/{mcp_server_name}/mcp` and `/sse`, and SSE messages post to `/mcp/sse/messages`. The `/tenant/<handle>/sse` and
   `/messages` shapes come from MCP SDK examples; flow C already rides the native `/{server_name}/mcp` shape.
3. **It keeps the registration requirement it set out to remove.** Stripping the tenant from the path lands the request
   on the aggregate endpoint, and every downstream decision (keyless admission, OAuth discovery, tool scoping, spend
   attribution, the RPT guardrail's tenant signal) keys on the registry entry resolved from the server name. Without a
   per-tenant entry the client must present a LiteLLM virtual key, which the middleware reads from a query parameter:
   customers holding gateway keys in URLs that land in access logs and browser history.
4. **The injected header never reaches the upstream.** The gateway assembles upstream headers from the entry's
   `static_headers` plus an explicit per-server allowlist of client headers, and drops an arbitrary `x-tenant-id`.
   Allowlisting the header instead would let any caller forge tenancy on paths the middleware does not match, whereas a
   minted entry's `static_headers` stay server-controlled.
5. **It breaks the OAuth challenge.** LiteLLM's own internal path rewriting (`_mcp_forward_as_path`) preserves the
   original public path in the request scope because challenge URLs must derive from the URL the client called. A
   middleware rewrite discards that path and strands external clients at the 401 step.

A premise behind the middleware idea also fell during verification: LiteLLM's MCP gateway is not built on FastMCP and
never has been. The first commit of the MCP server (March 2025) and the pinned 1.96.2 both build on the official MCP
SDK's low-level `mcp.server.Server`, and `fastmcp` appears in LiteLLM only as a test fixture for fake upstream servers.
Reasoning from FastMCP's mounting or middleware idioms does not transfer to this gateway.

### The test suite

The hooks carry a three-layer suite under `litellm/tests/`.

- **Layer A, behaviour.** `test_rpt_hook.py` and `test_tenant_resolver.py` cover token gating, exchange, caching,
  fail-closed errors, mint-on-miss, clone isolation, capacity eviction and negative caching, with all HTTP mocked.
- **Layer B, seam tripwires.** `test_litellm_seams.py` pins each internal LiteLLM assumption the modules ride on. A
  failure after an image bump names the seam to re-verify; the rule is written into the suite itself: never delete a
  tripwire to go green.
- **Layer C, black-box matrix.** `tests/integration/test_gateway_matrix.py` runs against a live gateway (gated on
  `GATEWAY_URL`) and checks the externally observable behaviour: prefixed tool listings, mint-on-miss equivalence, the
  OAuth challenge, convergence of garbage names to 401, and discovery metadata consistency.
  `tests/integration/test_tenant_limits.py` adds the two gates that need a real tenant principal, completing the PKCE
  login and letting the gateway run the RPT exchange: tenant-c's MCP tool calls refused in-band once its budget row's
  `rpm_limit` is spent, and tenant-e's completions refused with `type: budget_exceeded` once spend passes `max_budget`.
  Each gate owns a fixture tenant so an rpm limit cannot refuse a completion the spend gate was meant to catch, and
  setup only ever creates rows — never edits them — because a row changed mid-run stays invisible behind the ~60s
  management-object cache. Every case needs the platform services of this README running, which `make up` starts. What
  the gateway forwards upstream (the RPT and the tenant headers) is asserted in layer A, where the exchange is mocked.

Run the suite from the host:

```bash
make test-hooks         # layers A and B: unit and seam tests, in the dev container's venv
make test-integration   # layer C: black-box matrix against the running gateway
```

Unit tests run in the dev container's venv (`/opt/venv`, on PATH). Integration tests expect the gateway plus the
platform services or the fake harness (see `litellm/.gitlab-ci.yml` for the CI arrangement).

## LiteLLM upgrade policy

The design goal is that a LiteLLM upgrade is routine. Three rules make it so.

**Rule 1: one pinned version, everywhere.** The gateway image (`.devcontainer/docker-compose.yml`), the CI image
(`litellm/.gitlab-ci.yml`) and the dev container's Python environment (`litellm[proxy]==1.96.2` in
`.devcontainer/Dockerfile`) all pin the same version, because the seam tests only mean anything against the exact
runtime the gateway deploys. Never let any of the three float on a moving tag such as `main-stable`; a floating tag lets
a background pull move the gateway off the verified version without anyone choosing it.

**Rule 2: stay on public surfaces, and fence the one exception.** The tag hook and the RPT guardrail use LiteLLM's
supported extension points: the `CustomLogger` callback, the `CustomGuardrail` base class with `mode: pre_mcp_call`, and
config-directory module resolution. The tenant resolver is the exception. LiteLLM offers no wildcard registration and no
resolver hook, so the module patches one method, `MCPServerManager.get_mcp_server_by_name`, on the module singleton.
That is softer than a fork but version-coupled, and it is treated accordingly: the module fails loudly at boot if the
singleton or the method is missing, and every assumption around the patch is pinned by a tripwire test. Hooks import
only from `litellm.integrations.*`, `litellm.proxy._types`, `litellm.types.*` and that one manager module; any new
internal import must arrive with a new tripwire.

**Rule 3: expect churn in the MCP area.** LiteLLM's MCP code lives under an `_experimental` module path, and the
upstream documentation (checked in August 2026) already describes server-name compliance rules and tool-prefix
conventions that differ from the pinned image's behaviour, which our tenant-name encoding relies on. Treat any image
bump as a re-verification of the gateway modules above, not a formality.

The bump procedure:

1. Change the image pin and the venv pin to the same new version, in the same commit.
2. Rebuild the dev container (`make rebuild`).
3. Run layers A and B (`make test-hooks`). A seam failure names the assumption to re-verify against the new LiteLLM
   source; change the hook and its tripwire together, and never delete a tripwire to get a green run.
4. Boot the stack and run layer C (`make test-integration`).
5. Only then let the new image near a shared environment.

## Prerequisites

- Docker Desktop
- `devcontainer` CLI (`npm i -g @devcontainers/cli`) — no VS Code required

## Quickstart

```bash
make up
make sh
```

`make up` builds and starts five compose services: `dev` (workspace), `litellm` (gateway, official
`litellm-database:v1.96.2` image with `litellm/` mounted at `/etc/litellm`), `ollama` (local completion model,
`ollama/ollama:0.15.4`, models in the `ollama` volume), `postgres`, `redis`. The gateway image tag and the dev venv's
`litellm[proxy]==1.96.2` pin are deliberately the same version, per the version rule above. It then starts the six
platform services inside the dev container and waits for the gateway to report ready, so the stack is serving traffic
by the time `make up` returns.

It also seeds the completion model: `start-services.sh` reads the model name from the `openai/` entry in
`config.yaml`, asks Ollama what it holds, and pulls it into the `ollama` volume when missing (`qwen3:1.7b`, about
1.4 GB, roughly 30 seconds on first run and skipped in ~0.2s thereafter), so config and volume cannot drift apart.
`make pull-model` still forces a re-pull. Under Docker Desktop on macOS the container runs CPU-only — no Metal
passthrough into the Linux VM — so completions are slower than a host-side Ollama; the small model keeps that
tolerable.

## Claude Code sharing

The host `~/.claude` directory is mounted into the container and `CLAUDE_CONFIG_DIR` points at it, so skills, agents,
memory, settings, credentials, and session transcripts are shared both ways. The workspace is mounted inside the
container at the same absolute path as on the host (`WORKSPACE_PATH`, which the Makefile exports as `$(CURDIR)`), so `claude --resume`
inside the container lists the same sessions as on the host. `rtk` v0.45.0 (Linux build) is installed in the image so a
shared Bash PreToolUse hook that rewrites commands through `rtk` keeps working. Run `make claude` to start Claude Code
inside the container.

With `CLAUDE_CONFIG_DIR` set, the container keeps its config JSON at `~/.claude/.claude.json`; the host's root-level
`~/.claude.json` (including user-scope MCP servers registered on the host CLI) stays host-side, so re-register those in
the container if needed. Avoid running heavy Claude sessions on host and container simultaneously — both append to the
same `history.jsonl` and refresh the same `.credentials.json`.

## Gateway smoke test (from the host)

```bash
curl -s http://localhost:4010/v1/chat/completions \
  -H 'Authorization: Bearer sk-litellm-dev' \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-local","messages":[{"role":"user","content":"hello"}],"metadata":{"tags":["agent:poc"]}}'
```

Every completion request through the gateway must carry attribution tags. The tag hook (`litellm/custom_hooks.py`)
rejects with HTTP 400 any completion request whose `metadata.tags` is missing, `null` or an empty list, and any tag that
does not begin with `agent:`, `mcp:` or `tenant:` — attribution for cost and audit is a stated goal of this proof of
concept, so untagged completion traffic is not accepted. A body that sends `"metadata": null` is treated the same as
absent metadata and yields 400 rather than a server error. Non-completion traffic such as embeddings and MCP calls may
still omit tags, but any tags it does send are validated against the same prefixes.

Replace the tag above with `"poc"` to see the rejection.

The same endpoint also accepts tenant JWTs (`acme_custom_auth`, described under "What runs inside the gateway"): swap
the master key for a user's IDP access token and declare the tenant as a `tenant:<handle>` tag, or present an
already-minted RPT, whose permission names the tenant itself. A signed-in user without entitlement to the tagged
tenant receives 403; an IDP bearer without exactly one tenant tag receives 401. The e2e script's "Gateway JWT auth"
steps exercise all four outcomes.

## Local platform services

Each platform service is a pnpm workspace, and all six are started for you by `make up`
(`.devcontainer/start-services.sh`, logs in `/tmp/litellm-poc/`); `make services` re-runs it, skipping whatever is
already listening and waiting for the gateway to answer `/health/readiness` before it returns. Run one on its own with
`pnpm --filter @litellm-poc/<name> dev` from inside the dev container.

| Port | Service                           | Start                       |
| ---- | --------------------------------- | --------------------------- |
| 4000 | Main App frontend                 | `make up` / `make services` |
| 4004 | Main App backend (BFF)            | `make up` / `make services` |
| 4008 | Tenant Region Discovery Service   | `make up` / `make services` |
| 4014 | Authorization Server (Access API) | `make up` / `make services` |
| 4018 | Identity Server (OIDC)            | `make up` / `make services` |
| 4022 | Acme REST service + MCP server    | `make up` / `make services` |

The gateway's guardrails read their endpoints from environment variables on the `litellm` compose service:
`ACCESS_API_TEMPLATE` (default `http://dev:4014`), `DISCOVERY_API_URL` (default `http://dev:4008`) and
`OAUTH_ISSUER_TEMPLATE` (default `http://localhost:4018/eu/realms/acme,http://localhost:4018/us/realms/acme`). The
`{region}` placeholder is optional in `ACCESS_API_TEMPLATE`: the hook's `replace` is a no-op without it, so the single
local Access service answers for both regions at `http://dev:4014/token`, and an override may reintroduce `{region}` for
real regional endpoints. Each issuer in the template must equal an `iss` the Identity Server mints (the hook
string-compares it and never dereferences it), which is `http://localhost:4018/<region>/realms/acme`; the default lists
both regional issuers, so `eu` and `us` IDP tokens are exchangeable out of the box.

Follow the gateway logs, and restart the gateway after editing `litellm/config.yaml` or a hook module:

```bash
make logs-litellm
docker restart $(docker ps -q --filter "label=com.docker.compose.service=litellm" --filter "label=com.docker.compose.project.working_dir=$(pwd)/.devcontainer")
```

Changes to the compose `environment` block need more than a restart: recreate the service from the host with
`docker compose -f .devcontainer/docker-compose.yml up -d litellm` (or `make down && make up`).

## External MCP clients (T15)

The gateway front door at `http://localhost:4010/mcp/tenant_a` accepts any MCP client that speaks Streamable HTTP with
OAuth. An unauthenticated request receives a 401 whose `WWW-Authenticate` header names the gateway's RFC 9728
protected-resource metadata; from there the client discovers the gateway's authorisation-server metadata and walks its
relay endpoints (`/tenant_a/register`, `/tenant_a/authorize`, `/tenant_a/token`). The relay pins its upstream endpoints
in `litellm/config.yaml`: `authorization_url` sends the browser to the Identity Server on `localhost:4018`, `token_url`
lets the gateway container redeem codes through `dev:4018`, and `client_id: poc` names the fixed public client. The
Identity Server's discovery document advertises registration, and `POST /{region}/oidc/register` answers RFC 7591
requests with that client, so a client that insists on dynamic registration completes it against either party.

Connect Claude Code through `mcp-remote`, the adapter Claude Desktop configurations use for remote servers:

```bash
claude mcp add tenant-a --transport stdio -- npx -y mcp-remote http://localhost:4010/mcp/tenant_a --allow-http
claude mcp add tenant-b --transport stdio -- npx -y mcp-remote http://localhost:4010/mcp/tenant_b --allow-http
```

On first use `mcp-remote` opens the Identity Server's login form in your browser; sign in as `admin_a@test.com` /
`123456`. The client walks away with the IDP access token, and the `acme-mcp-rpt` guardrail exchanges that token for a
tenant-scoped RPT on every `tools/call`.

Complete the login inside Claude Code's MCP startup timeout. When the timeout kills the bridge mid-login, the loopback
callback listener dies with it and the browser reports `Unable to connect` on `localhost:<port>/oauth/callback`;
reloading that tab cannot succeed, because authorisation codes are single-use and expire after 60 seconds.
Pre-authenticate with a standalone run, which no timeout governs:

```bash
npx -y mcp-remote http://localhost:4010/mcp/tenant_a --allow-http
```

Sign in when the browser opens and Ctrl-C once it reports the proxy established; the tokens land in `~/.mcp-auth`, keyed
by server URL, and the bridge Claude Code spawns for the same URL reuses them without a browser step.
`MCP_TIMEOUT=300000 claude` (milliseconds) widens the window for a one-shot login instead.

Recorded transcript, run inside the dev container where the gateway is `http://litellm:4000` (from the host, substitute
`http://localhost:4010`):

```
$ claude -p "Call the tenant-a MCP tool that lists projects and show me the raw result. Then call
  the tenant-a MCP tool that lists projects with no arguments and report the exact error text it
  returns." --allowedTools mcp__tenant-a,mcp__tenant-b

mcp__tenant-a__tenant_a-list_projects {}
  -> [{"description":"Seeded example project so tenant-a lists are non-empty out of the box",
      "id":"proj-1","name":"Example Project"}]

mcp__tenant-b__tenant_b-list_projects {}
  -> Error: {'error': 'Not entitled to this tenant', 'guardrail_name': 'acme-mcp-rpt',
     'guardrail_mode': 'pre_mcp_call'}
```

Both servers accept the connection, because delegate admission checks bearer presence for `initialize` and `tools/list`.
The entitlement check runs at `tools/call`: the Access API refuses to mint a tenant-b RPT for `admin_a` with 403, and
the guardrail surfaces the refusal in the MCP error body. `tenant_b` has no `mcp_servers` entry; the mint-on-miss
resolver materialises it from the `tenant_a` template on first sight, OAuth endpoints included.

Tokens age out: the IDP access token lives for 900 seconds, the single-use refresh token for 30 minutes, and the
refresh-token store and signing key live in Identity Server memory, so a restart orphans cached tokens too. `mcp-remote`
refreshes only on an HTTP 401 challenge from the transport, and the guardrail reports failure in-band as a JSON-RPC tool
error, so a stale cached token fails every `tools/call` with
`{'error': 'RPT exchange failed', 'guardrail_name': 'acme-mcp-rpt', 'guardrail_mode': 'pre_mcp_call'}` and never
triggers a refresh. `make logs-litellm` shows the Access API status the generic message hides
(`AcmeMcpRptHook: RPT exchange failed status=401`, the Access service's `Unverifiable bearer token` refusal). Recover
with `rm -rf ~/.mcp-auth` and a `/mcp` reconnect.

Claude Desktop routes custom-connector OAuth through claude.ai's callback, and the gateway relay accepts loopback
redirect URIs alone, so give Claude Desktop the same `mcp-remote` command in its MCP configuration file instead of a
custom connector. Remove the demo servers with `claude mcp remove tenant-a` and `claude mcp remove tenant-b`.

## Monorepo

pnpm workspaces (`services/*`, `packages/*`), ESLint 9 flat config, Prettier, Vitest, strict TypeScript (NodeNext). Root
scripts: `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm format`. Start the sample service with `make dev`, then:

```bash
curl -s http://localhost:4004/healthz
curl -s -X POST http://localhost:4004/chat -d '{"prompt":"hello","tenant":"tenant-a"}'
```
