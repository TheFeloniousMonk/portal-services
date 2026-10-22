FROM node:24.22.1-alpine
WORKDIR /app
# NODE_NO_WARNINGS hides the one-line notice that node:sqlite is experimental.
ENV NODE_ENV=production PORT=8080 PUMP_DATA_DIR=/data NODE_NO_WARNINGS=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Every top-level module, by glob, so a new module is never left out of the
# image (TaintCheck 1.1.0 shipped without one). test/ is excluded by
# .dockerignore. probe-artifact.json is the compiled honeypot probe.
COPY *.js openapi.json probe-artifact.json ./
# The peer-sync modules (1.1.0) live in their own directory, which the glob above skips.
COPY peer/ ./peer/
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
# 8080 serves relays; 8090 is the peer API, reached only through the /pump-check-peer route.
EXPOSE 8080 8090
USER node
# Ready once an ingest has completed in the last 10 minutes and at least one
# chain's RPC answers. The first ingest takes about 10 seconds.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
