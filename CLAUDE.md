# litellm-poc

LiteLLM gateway POC. Python hooks live in `litellm/` (mounted into the gateway container at `/etc/litellm`); TypeScript services live in `services/*` as pnpm workspaces.

## Environment

- Inside the devcontainer the gateway is `$GATEWAY_URL` (`http://litellm:4000`); from the host it is `http://localhost:4010`. Auth: `Authorization: Bearer $LITELLM_MASTER_KEY` (`sk-litellm-dev`).
- Service ports follow the README's service landscape: Main App 4000 (frontend) and 4004 (backend), Discovery 4008, LiteLLM 4010, Access 4014, Identity 4018, MCP services 4022. Mock MCP servers belong on dev:3100 / dev:3200.
- Every LiteLLM request must carry `metadata.tags` entries prefixed `agent:`, `mcp:`, or `tenant:` — `litellm/custom_hooks.py` rejects anything else with HTTP 400.
- `litellm/config.yaml` references module-level hook instances (`custom_hooks.TagValidationHook`); LiteLLM resolves them relative to the config directory, so hook modules stay next to `config.yaml`.
- LiteLLM's config-dir loaders (`get_instance_fn` and the guardrail initialiser) exec the module by file path WITHOUT adding the config directory to `sys.path`, so a config-dir module importing a sibling (`acme_tokens`) must self-insert `os.path.dirname(__file__)` into `sys.path` before that import — `acme_custom_auth.py` and `acme_mcp_rpt_hook.py` carry the shim, and `test_get_instance_fn_execs_file_without_config_dir_on_sys_path` trips if a LiteLLM bump changes the loader.
- The devcontainer shell is zsh: unquoted `$VARS` do not word-split, so `kill $PIDS` fails silently — pipe `pgrep` into `xargs -r kill`. A `pgrep -f`/`pkill -f` pattern must be self-escaped (`[s]rc/server.ts`) and must not appear as plain text anywhere else on the same command line, or it matches the invoking shell; keep the kill in a command of its own.

## Commands

- TS: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format` at the repo root; `pnpm --filter @litellm-poc/main-app dev` to run a service.
- Python hooks: `cd litellm && python -m pytest tests -q -m "not integration"`; integration needs `GATEWAY_URL` and the fake upstream harness (`litellm/.gitlab-ci.yml`).
- Gateway logs: `make logs-litellm` from the host.

## Conventions

- New services copy the `services/main-app` shape: `src/types.ts` for shared types, `tsx` for dev, Vitest for tests, no runtime dependencies unless required.
- Helpers and fixture data used by two or more packages live in `@litellm-poc/core` (`packages/core`), never re-declared per service: `respondJson`, `errorMessage`, `respondCorsPreflight`, `CORS_ALLOW_ALL_ORIGIN`, and the tenant fixture `FIXTURE_USERS` with its derived `ENTITLEMENTS` and `TENANT_REGIONS` views.
- Per-service response policy is one named wrapper over the core mechanics, named for the why: `respondOAuthJson` (RFC 6749 `no-store`), `respondCorsJson` (browser-called services).
- Prefer Node built-ins to hand-rolled plumbing: request bodies are read with `await text(request)` from `node:stream/consumers` (`Readable.toArray()` is still experimental).
- HTTP routing dispatches with a `switch` on a `` `${method} ${path}` `` key after normalising any dynamic prefix — no sequential if/else chains, and no negated compound guard where a `default:` case says the same thing directly.
- When an `as const` tuple feeds a lookup map, widen at the map (`new Map<string, T>(...)`) so `.get(string)` stays callable.
- Run `pnpm format:check` before every commit.
- Restart the litellm compose service after editing `litellm/config.yaml` or hook modules; the dev container does not need a rebuild for that.
- In `mcp_servers` OAuth config, a pinned `issuer` is the sole endpoint source (RFC 8414 §3.3): it discards manual `authorization_url`/`token_url` and fails closed when the issuer document's self-attested value differs from the configured one, so split-horizon setups (browser vs container hostnames) pin the endpoint URLs and omit `issuer`.
- The gateway image tag (`.devcontainer/docker-compose.yml`) and the dev venv pin (`litellm[proxy]==…` in `.devcontainer/Dockerfile`) must stay on the same LiteLLM version: `litellm/tests/conftest.py` seam tests are only meaningful against the exact runtime the gateway deploys, so bump both together.
