FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/runtime/package.json apps/runtime/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
CMD ["node", "apps/api/src/server.mjs"]
