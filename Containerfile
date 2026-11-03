# GRF Compare — zero-dependency Node proxy app.
# Pinned to the Node2Shell patch release (>= 22.23.4, CVE-2026-111497).
FROM docker.io/library/node:22.23.4-alpine

ENV NODE_ENV=production
WORKDIR /app

# Only the runtime needs: server.js + public/ assets. No npm deps exist.
COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public

# App writes its fetch cache to ./cache — mount a named volume here.
VOLUME /app/cache

USER node
EXPOSE 3020
CMD ["node", "server.js"]
