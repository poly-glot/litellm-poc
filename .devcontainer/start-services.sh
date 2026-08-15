#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

SERVICES=(
    access:4014
    acme-service:4022
    identity:4018
    main-app:4004
    main-app-frontend:4000
    tenant-discovery:4008
)

LOG_DIR=/tmp/litellm-poc
GATEWAY_URL=${GATEWAY_URL:-http://litellm:4000}
OLLAMA_URL=${OLLAMA_URL:-http://ollama:11434}

listening() {
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

gateway_ready() {
    curl -fs --max-time 2 -o /dev/null "$GATEWAY_URL/health/readiness"
}

mkdir -p "$LOG_DIR"

for entry in "${SERVICES[@]}"; do
    service=${entry%:*}
    port=${entry#*:}

    if listening "$port"; then
        echo "$service already listening on $port"
        continue
    fi

    setsid nohup pnpm --filter "@litellm-poc/$service" dev > "$LOG_DIR/$service.log" 2>&1 &
done

for entry in "${SERVICES[@]}"; do
    service=${entry%:*}
    port=${entry#*:}

    for _ in $(seq 40); do
        listening "$port" && break
        sleep 0.5
    done

    listening "$port" || {
        echo "$service never came up on $port; see $LOG_DIR/$service.log" >&2
        exit 1
    }

    echo "$service ready on $port"
done

for _ in $(seq 60); do
    gateway_ready && break
    sleep 1
done

gateway_ready || {
    echo "gateway never became ready at $GATEWAY_URL; see make logs-litellm" >&2
    exit 1
}

echo "gateway ready at $GATEWAY_URL"

MODEL=$(sed -n 's|^ *model: openai/\(.*\)$|\1|p' litellm/config.yaml | head -n 1)

ollama_ready() {
    curl -fs --max-time 2 -o /dev/null "$OLLAMA_URL/api/tags"
}

model_seeded() {
    curl -fs --max-time 5 "$OLLAMA_URL/api/tags" | grep -q "\"name\":\"$MODEL\""
}

if [ -z "$MODEL" ]; then
    echo "no openai/ model declared in litellm/config.yaml; nothing to seed" >&2
    exit 0
fi

for _ in $(seq 30); do
    ollama_ready && break
    sleep 1
done

if ! ollama_ready; then
    echo "ollama unreachable at $OLLAMA_URL; '$MODEL' not seeded, completions will fail until make pull-model" >&2
    exit 0
fi

if model_seeded; then
    echo "$MODEL already seeded"
    exit 0
fi

echo "pulling $MODEL into the ollama volume (first run, about 1.4GB)"
if curl -s --max-time 1800 -X POST "$OLLAMA_URL/api/pull" -d "{\"model\":\"$MODEL\"}" | tail -n 1 | grep -q '"status":"success"'; then
    echo "$MODEL ready"
else
    echo "pulling $MODEL failed; run make pull-model" >&2
fi
