# syntax=docker/dockerfile:1

FROM golang:1.27.1-bookworm@sha256:648f440f42a0958804efb24df176f806f9d353b41f1c0627f666428e40310f6b AS go-toolchain
FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS node-toolchain
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun-toolchain
FROM rust:1.99.1-slim-bookworm@sha256:f2c004e3d2d8b547e8cf7ffbc29205385f4e71d23e53e4e383065db5e9f822cd AS rust-toolchain

FROM ubuntu:26.04@sha256:d66b366dac61b575bee2aef07e9c26e8070096fbe84a3d4d3eb0da069b5d76db AS lean

# Resolute's packaged Git supports the required --no-lazy-fetch option.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        libstdc++6 \
        python3-venv \
        ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && git --no-lazy-fetch version \
    && test -x "$(git --exec-path)/git-remote-https"

COPY --from=node-toolchain /usr/local/bin/node /usr/local/bin/node
COPY --from=bun-toolchain /usr/local/bin/bun /usr/local/bin/bun

# Keep the official standalone package pinned and outside the benchmark's mounted homes.
ARG CODEX_RELEASE=0.172.0
ARG CODEX_INSTALL_SCRIPT_SHA256=b698d8eb50c0fbe0214ea57b5bf2af439054108404c6d2b872989db02f4bd574
RUN curl -fsSL "https://github.com/openai/codex/releases/download/rust-v${CODEX_RELEASE}/install.sh" -o /tmp/codex-install.sh \
    && echo "${CODEX_INSTALL_SCRIPT_SHA256}  /tmp/codex-install.sh" | sha256sum --check --strict \
    && CODEX_RELEASE="${CODEX_RELEASE}" CODEX_HOME=/opt/codex CODEX_INSTALL_DIR=/usr/local/bin CODEX_NON_INTERACTIVE=1 \
        sh /tmp/codex-install.sh \
    && rm /tmp/codex-install.sh \
    && ln -s /opt/codex/packages/standalone/current/bin/codex-code-mode-host \
        /usr/local/bin/codex-code-mode-host \
    && test -x /usr/local/bin/codex-code-mode-host \
    && ! command -v hpatch \
    && ! command -v mekugi \
    && /usr/local/bin/codex --version | grep -Fq "${CODEX_RELEASE}" \
    && node --version && bun --version \
    && install -d /usr/local/libexec /root/.config /agent-issue-reports /go/pkg/mod \
    && ln "$(readlink -f /usr/local/bin/codex)" /usr/local/libexec/codex-real

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

FROM lean AS model-free
USER root
COPY tasks/flask-ipv6-server-name/requirements.txt /tmp/flask-qualification-requirements.txt
RUN python3 -m venv /opt/task-deps/python \
    && /opt/task-deps/python/bin/pip install --no-cache-dir -r /tmp/flask-qualification-requirements.txt
ARG FIXTURE_UID=1001
ARG FIXTURE_GID=1001
RUN mkdir -p /home/ubuntu/.codex \
    && chown -R "${FIXTURE_UID}:${FIXTURE_GID}" /home/ubuntu /workspace
USER ${FIXTURE_UID}:${FIXTURE_GID}

FROM lean AS rust
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup
COPY --from=rust-toolchain /usr/local/cargo/bin /usr/local/bin
ENV CARGO_HOME=/opt/task-deps/cargo \
    CARGO_TARGET_DIR=/tmp/task-rust-target \
    RUSTUP_HOME=/usr/local/rustup \
    RUSTUP_TOOLCHAIN=1.99.1
RUN rustup component add rustfmt clippy \
    && cargo --version && rustc --version
USER ubuntu

FROM lean AS full
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ iptables make pkg-config \
    && rm -rf /var/lib/apt/lists/*
COPY --from=go-toolchain /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"
RUN go version
USER ubuntu
