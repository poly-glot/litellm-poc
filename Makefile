DC = devcontainer
WORKSPACE = --workspace-folder .
COMPOSE_DIR = $(CURDIR)/.devcontainer

export WORKSPACE_PATH := $(CURDIR)

.PHONY: up rebuild down sh claude dev services test lint typecheck format test-hooks test-integration logs-litellm pull-model

up:
	$(DC) up $(WORKSPACE)
	$(MAKE) services

rebuild:
	$(DC) up $(WORKSPACE) --remove-existing-container --build-no-cache
	$(MAKE) services

services:
	$(DC) exec $(WORKSPACE) bash .devcontainer/start-services.sh

down:
	ids=$$(docker ps -aq --filter "label=com.docker.compose.project.working_dir=$(COMPOSE_DIR)"); [ -n "$$ids" ] && docker rm -f $$ids || true

sh:
	$(DC) exec $(WORKSPACE) zsh

claude:
	$(DC) exec $(WORKSPACE) claude

dev:
	$(DC) exec $(WORKSPACE) pnpm --filter @litellm-poc/main-app dev

test:
	$(DC) exec $(WORKSPACE) pnpm test

lint:
	$(DC) exec $(WORKSPACE) pnpm lint

typecheck:
	$(DC) exec $(WORKSPACE) pnpm typecheck

format:
	$(DC) exec $(WORKSPACE) pnpm format

test-hooks:
	$(DC) exec $(WORKSPACE) bash -lc 'cd litellm && python -m pytest tests -q -m "not integration"'

test-integration:
	$(DC) exec $(WORKSPACE) bash -lc 'cd litellm && python -m pytest tests -q -m integration'

logs-litellm:
	docker logs -f $$(docker ps -q --filter "label=com.docker.compose.service=litellm" --filter "label=com.docker.compose.project.working_dir=$(COMPOSE_DIR)")

pull-model:
	docker exec $$(docker ps -q --filter "label=com.docker.compose.service=ollama" --filter "label=com.docker.compose.project.working_dir=$(COMPOSE_DIR)") ollama pull qwen3:1.7b
