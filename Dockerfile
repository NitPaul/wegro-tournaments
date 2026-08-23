# WeGro Tournaments
#
# One stage, because there is nothing to build. The browser app is plain HTML,
# CSS and ES modules served as-is, and the server has a single runtime
# dependency. Everything else — SQLite, password hashing, the HTTP server — is
# Node's standard library, so this image compiles nothing and pulls in nothing
# that needs auditing.
#
#   docker build -t wegro-tournaments .
#   docker run --env-file .env -p 3000:3000 -v wegro-data:/data wegro-tournaments

FROM node:24-alpine

# tini reaps zombies and forwards signals properly, so SIGTERM from `docker
# stop` actually reaches Node and the graceful shutdown runs. Without it, PID 1
# is Node and container stops become ten-second kills.
RUN apk add --no-cache tini wget

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first: this layer is only rebuilt when the manifests change, so
# ordinary code edits rebuild in about a second.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY server/ ./server/
COPY shared/ ./shared/
COPY public/ ./public/
COPY tools/ ./tools/

# The database lives on a mounted volume, not in the image, so rebuilding never
# touches the data. `node` is the unprivileged user the base image already ships.
RUN mkdir -p /data /backups && chown -R node:node /data /backups /app
ENV DATA_DIR=/data \
    BACKUP_DIR=/backups \
    PORT=3000 \
    HOST=0.0.0.0

USER node
EXPOSE 3000

# Hits the dependency-free health route, so an unhappy database shows up as an
# unhealthy container rather than a silently broken site.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
