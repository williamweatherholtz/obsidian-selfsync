# Single self-hostable binary — the new-livesync sync server.
# Multi-stage: compile with the Rust toolchain, ship a slim runtime image.
FROM rust:1-slim AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/new-livesync-server /usr/local/bin/new-livesync-server
ENV DATA_ROOT=/data \
    BIND_ADDR=0.0.0.0:8080 \
    SYNC_USER=admin \
    SYNC_PASSWORD=admin
# SEC-DEPLOY (audit): run as a non-root user, not UID 0 — so a future RCE or container escape can't
# operate with root privileges. Own the data volume so the unprivileged process can still write it.
RUN useradd --system --uid 10001 --home-dir /data --no-create-home selfsync \
 && mkdir -p /data && chown selfsync:selfsync /data
USER selfsync
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=3s --timeout=2s --start-period=2s --retries=10 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1
CMD ["new-livesync-server"]
