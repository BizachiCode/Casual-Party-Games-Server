# Build: compile the TypeScript sources.
FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca \
    set -eu; if [ -s /run/secrets/npm_ca ]; then export npm_config_cafile=/run/secrets/npm_ca; fi; \
    npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Run: production dependencies, compiled server and game data only, as the unprivileged node user.
FROM node:24.19.0-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=2567 PARTY_CONTENT_BUNDLE=/app/content/party-bundle.json
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=npm_ca \
    set -eu; if [ -s /run/secrets/npm_ca ]; then export npm_config_cafile=/run/secrets/npm_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund && mkdir -p /app/data /app/content && chown -R node:node /app/data /app/content
COPY --chown=node:node --from=build /app/build ./build
COPY --chown=node:node game_config ./game_config
COPY --chown=node:node certs ./certs
USER node
EXPOSE 2567
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:2567/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build/index.js"]
