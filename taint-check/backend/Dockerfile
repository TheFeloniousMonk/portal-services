FROM node:24.22.1-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 TC_DATA_DIR=/data
COPY package.json ./
# Every top-level module, by glob: a hand-kept list left fetcher.js out of the
# 1.1.0 image and the container crash-looped on deploy. test/ is excluded by
# .dockerignore.
COPY *.js openapi.json ./
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8080
USER node
# Readiness only flips to ok once an OSV snapshot is loaded; the long start
# period covers the first mirror sync on a cold volume.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
