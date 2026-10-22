FROM node:24.22.1-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 MW_DATA_DIR=/data
COPY package.json ./
COPY config.js dexpaprika.js store.js poller.js server.js openapi.json ./
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8080
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
