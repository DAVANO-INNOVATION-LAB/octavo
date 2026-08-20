# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 compiles from source when no prebuild matches
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- run ----
FROM node:22-bookworm-slim AS run
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

# The runtime never installs packages: remove npm, corepack, and yarn so
# their dependency trees (and their CVEs) never ship.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Native module: make sure the compiled binding ships even if tracing missed it.
COPY --from=build /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# The collaboration server is loaded by our own entry rather than imported by
# the app, so Next's dependency tracing never sees these. Without them the
# editor still works and co-editing does not, which is the confusing failure.
COPY --from=build /app/node_modules/ws ./node_modules/ws
COPY --from=build /app/node_modules/yjs ./node_modules/yjs
COPY --from=build /app/node_modules/y-protocols ./node_modules/y-protocols
COPY --from=build /app/node_modules/lib0 ./node_modules/lib0
COPY --from=build /app/server ./server

RUN mkdir -p /data /app/.next/cache && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/octavo-server.cjs"]
