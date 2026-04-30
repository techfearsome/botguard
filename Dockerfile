# Multi-stage build for smaller production image
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

# Drop privileges - create a non-root user
RUN addgroup -S botguard && adduser -S botguard -G botguard

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
CMD ["node", "src/server.js"]
