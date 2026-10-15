FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json ./
# Every top-level module, by glob, so a new module is never left out of the
# image. test/ is excluded by .dockerignore.
COPY *.js openapi.json ./
RUN chown -R node:node /app
EXPOSE 8080
USER node
# Readiness is ok while the infiniFi protocol data can be served (fresh, or a
# cached copy from the last 15 minutes).
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
