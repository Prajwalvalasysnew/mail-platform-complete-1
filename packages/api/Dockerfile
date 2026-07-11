FROM node:20-alpine AS base
WORKDIR /app

# Copy the lockfile and complete workspace manifest/source tree so npm ci uses
# exactly the dependency graph audited in CI. Partial workspace copies force
# npm install to resolve a different, potentially vulnerable graph.
COPY package.json package-lock.json tsconfig.base.json ./
COPY infra/migrations ./infra/migrations
COPY packages ./packages

# Install deps deterministically (workspaces)
RUN npm ci --workspaces --include-workspace-root

# Build
RUN npm run build --workspace=@platform/shared
RUN npm run build --workspace=@platform/api
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:20-alpine
WORKDIR /app
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=base /app /app
# Drop root: node:20-alpine ships a built-in 'node' user (uid 1000).
RUN chown -R node:node /app
USER node
EXPOSE 3000
# Migrations run in a dedicated release job (see infra/helm .../migration-job.yaml),
# NOT at app startup — multiple replicas racing migrations on deploy is unsafe.
CMD ["node", "packages/api/dist/server.js"]
