FROM mcr.microsoft.com/devcontainers/typescript-node:22-trixie

ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
        arm64) rtk_asset=rtk-aarch64-unknown-linux-gnu ;; \
        *) rtk_asset=rtk-x86_64-unknown-linux-musl ;; \
    esac \
    && mkdir -p /tmp/rtk \
    && curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/v0.45.0/${rtk_asset}.tar.gz" | tar -xz -C /tmp/rtk \
    && install -m 0755 "$(find /tmp/rtk -type f -name rtk | head -1)" /usr/local/bin/rtk \
    && rm -rf /tmp/rtk

RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$TARGETARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian trixie stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

COPY litellm/tests/requirements.txt /tmp/litellm-test-requirements.txt

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir "litellm[proxy]==1.96.2" -r /tmp/litellm-test-requirements.txt \
    && chown -R node:node /opt/venv

ENV PATH=/opt/venv/bin:$PATH

RUN npm install -g @anthropic-ai/claude-code pnpm
