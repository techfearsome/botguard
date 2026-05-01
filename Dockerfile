# Multi-stage build for smaller production image
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

# Drop privileges - create a non-root user
RUN addgroup -S botguard && adduser -S botguard -G botguard

# tini is a tiny init that forwards signals correctly. Without it, Node's process
# ID is 1 and SIGTERM from Docker stop / Coolify restart doesn't trigger graceful
# shutdown - active requests get cut off. With tini, we get clean rolling deploys.
RUN apk add --no-cache tini

# Copy production node_modules
COPY --from=deps --chown=botguard:botguard /app/node_modules ./node_modules

# Copy app source
COPY --chown=botguard:botguard . .

# Healthcheck endpoint exists at /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:${PORT:-3000}/healthz || exit 1

USER botguard
EXPOSE 3000

ENV NODE_ENV=production
# Cap Node's heap to 384MB so we never OOM the host on a shared 4GB VPS.
# Leave 128MB headroom for the Node runtime itself + native libs + Mongoose.
# Adjust upward if you have a dedicated box with more RAM.
ENV NODE_OPTIONS="--max-old-space-size=384"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
