# Multi-target Rust build. Pass BIN=kerby-api or BIN=kerby-worker to select.
FROM rust:1.83-slim AS builder
ARG BIN=kerby-api
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Cache deps: copy manifests first.
COPY Cargo.toml Cargo.lock ./
COPY crates/domain/Cargo.toml crates/domain/Cargo.toml
COPY crates/api/Cargo.toml crates/api/Cargo.toml
COPY crates/worker/Cargo.toml crates/worker/Cargo.toml
RUN mkdir -p crates/domain/src crates/api/src crates/worker/src && \
    echo "fn main(){}" > crates/api/src/main.rs && \
    echo "fn main(){}" > crates/worker/src/main.rs && \
    echo "" > crates/domain/src/lib.rs && \
    cargo build --release --bin "$BIN" || true

# Real sources.
COPY crates crates
COPY migrations migrations
RUN touch crates/api/src/main.rs crates/worker/src/main.rs crates/domain/src/lib.rs && \
    cargo build --release --bin "$BIN"

FROM debian:bookworm-slim AS runtime
ARG BIN=kerby-api
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/${BIN} /app/bin
COPY migrations /app/migrations
ENV RUST_LOG=info
EXPOSE 8080
ENTRYPOINT ["/app/bin"]
