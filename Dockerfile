# syntax=docker/dockerfile:1

FROM golang:1.27.1-bookworm@sha256:648f440f42a0958804efb24df176f806f9d353b41f1c0627f666428e40310f6b AS go-toolchain
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS node-toolchain

FROM ubuntu:24.04@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517

# Use public, digest-pinned official toolchains without inheriting Mekugi,
# wrappers, source, home state, or credentials.
COPY --from=go-toolchain /usr/local/go /usr/local/go
COPY --from=node-toolchain /usr/local/bin/node /usr/local/bin/node
ENV PATH="/usr/local/go/bin:/usr/local/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        g++ \
        gcc \
        git \
        iptables \
        util-linux \
        make \
        pkg-config \
        python3 \
        python3-venv \
        ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && go version \
    && node --version

# The comparison is bare Codex versus bare Codex. Copy the same audited
# standalone CLI and its code-mode host used by both arms from an explicit
# BuildKit named context.
ARG CODEX_SHA256
ARG CODEX_CODE_MODE_HOST_SHA256
COPY --from=codex_binary codex /usr/local/bin/codex
COPY --from=codex_binary codex-code-mode-host /usr/local/bin/codex-code-mode-host
RUN chmod 0755 /usr/local/bin/codex /usr/local/bin/codex-code-mode-host \
    && printf '%s  %s\n%s  %s\n' \
        "$CODEX_SHA256" /usr/local/bin/codex \
        "$CODEX_CODE_MODE_HOST_SHA256" /usr/local/bin/codex-code-mode-host \
        | sha256sum --check --strict \
    && ! command -v hpatch \
    && ! command -v mekugi \
    && /usr/local/bin/codex --version \
    && install -d /usr/local/libexec /root/.config /benchmark-agent-issue-reports /go/pkg/mod \
    && ln /usr/local/bin/codex /usr/local/libexec/codex-real

ARG BENCH_UID=1000
ARG BENCH_GID=1000
RUN if getent group ubuntu >/dev/null; then \
        groupmod --gid "$BENCH_GID" ubuntu; \
    else \
        groupadd --gid "$BENCH_GID" ubuntu; \
    fi \
    && if id ubuntu >/dev/null 2>&1; then \
        usermod --uid "$BENCH_UID" --gid "$BENCH_GID" --home /home/ubuntu ubuntu; \
    else \
        useradd --create-home --uid "$BENCH_UID" --gid "$BENCH_GID" --home-dir /home/ubuntu ubuntu; \
    fi \
    && install -d -o ubuntu -g ubuntu /home/ubuntu /home/ubuntu/.local /home/ubuntu/.local/share /home/ubuntu/.local/share/mise /home/ubuntu/.local/share/mise/installs /workspace
WORKDIR /workspace
USER ubuntu
ENV HOME=/home/ubuntu CODEX_HOME=/home/ubuntu/.codex
ENTRYPOINT []
