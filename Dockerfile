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
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    OCTAVO_DATA_DIR=/data \
    PORT=3000 \
    HOSTNAME=0.0.0.0

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# Native module: make sure the compiled binding ships even if tracing missed it.
COPY --from=build /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
