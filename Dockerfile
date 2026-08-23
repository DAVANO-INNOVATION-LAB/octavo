# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
# better-sqlite3 compiles from source when no prebuild matches.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Trim what the runtime cannot use. This has to happen here: deleting in a
# later layer leaves the bytes in an earlier one, and the image is carried
# across an air gap on physical media.
RUN rm -rf \
      node_modules/better-sqlite3/deps \
      node_modules/better-sqlite3/src \
      node_modules/better-sqlite3/prebuilds/win32-x64 \
      node_modules/better-sqlite3/prebuilds/win32-arm64 \
      node_modules/better-sqlite3/prebuilds/darwin-x64 \
      node_modules/better-sqlite3/prebuilds/darwin-arm64 \
      node_modules/better-sqlite3/prebuilds/linux-x64 \
      node_modules/better-sqlite3/prebuilds/linux-arm64 \
    && find node_modules/yjs node_modules/y-protocols node_modules/lib0 \
      \( -name '*.map' -o -name '*.ts' \) -delete 2>/dev/null || true

# ---- run ----
FROM alpine:3.22 AS run
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/DAVANO-INNOVATION-LAB/octavo" \
      org.opencontainers.image.vendor="Davano Innovation Lab" \
      org.opencontainers.image.title="Octavo" \
      org.opencontainers.image.description="Open-source documentation that reads like a book." \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    OCTAVO_DATA_DIR=/data \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The runtime is a bare Alpine with the node binary copied in, rather than the
# node image with the package managers deleted afterwards. Deleting them in a
# later layer removes them from the filesystem but not from the image: the
# bytes stay in the base layer, still shipped and still found by anything that
# reads layers rather than the running container.
#
# libstdc++ is what the node binary links against; nothing else is added.
RUN apk add --no-cache libstdc++ \
    && addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=node:22-alpine /usr/local/bin/node /usr/local/bin/node

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Native module: make sure the compiled binding ships even if tracing missed it.
COPY --from=build --chown=node:node /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# The collaboration server is loaded by our own entry rather than imported by
# the app, so Next's dependency tracing never sees these. Without them the
# editor still works and co-editing does not, which is the confusing failure.
COPY --from=build --chown=node:node /app/node_modules/ws ./node_modules/ws
COPY --from=build --chown=node:node /app/node_modules/yjs ./node_modules/yjs
COPY --from=build --chown=node:node /app/node_modules/y-protocols ./node_modules/y-protocols
COPY --from=build --chown=node:node /app/node_modules/lib0 ./node_modules/lib0
COPY --from=build --chown=node:node /app/server ./server

RUN mkdir -p /data /app/.next/cache && chown node:node /data /app/.next/cache
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/octavo-server.cjs"]
