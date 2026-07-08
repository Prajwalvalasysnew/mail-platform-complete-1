FROM node:20-alpine AS base
WORKDIR /app

# Copy workspace files
COPY package.json tsconfig.base.json ./
COPY infra/migrations ./infra/migrations
COPY packages/shared ./packages/shared
COPY packages/api ./packages/api

# Install deps (workspaces)
RUN npm install --workspaces --include-workspace-root

# Build
RUN npm run build --workspace=@platform/shared
RUN npm run build --workspace=@platform/api

FROM node:20-alpine
WORKDIR /app
COPY --from=base /app /app
# Drop root: node:20-alpine ships a built-in 'node' user (uid 1000).
RUN chown -R node:node /app
USER node
EXPOSE 3000
# Migrations run in a dedicated release job (see infra/helm .../migration-job.yaml),
# NOT at app startup — multiple replicas racing migrations on deploy is unsafe.
CMD ["node", "packages/api/dist/server.js"]
