FROM node:22-alpine AS base
WORKDIR /app

# Copy every workspace manifest before source. npm still resolves the complete,
# lockfile-pinned workspace graph, while ordinary source edits no longer
# invalidate the expensive dependency layer.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/admin-console/package.json packages/admin-console/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/customer-ui/package.json packages/customer-ui/package.json
COPY packages/landing-page/package.json packages/landing-page/package.json
COPY packages/docs/package.json packages/docs/package.json
COPY packages/haraka-inbound/package.json packages/haraka-inbound/package.json
COPY packages/haraka-outbound/package.json packages/haraka-outbound/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/smtp-gateway/package.json packages/smtp-gateway/package.json
COPY packages/tests/package.json packages/tests/package.json
COPY packages/tracker/package.json packages/tracker/package.json
COPY packages/worker/package.json packages/worker/package.json

# Install deps deterministically (workspaces)
RUN --mount=type=cache,target=/root/.npm \
  npm ci --workspaces --include-workspace-root

# Build
COPY infra/migrations ./infra/migrations
COPY packages ./packages
RUN npm run build --workspace=@platform/shared
RUN npm run build --workspace=@platform/api
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-alpine
WORKDIR /app
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --chown=node:node --from=base /app /app
# Drop root: node:20-alpine ships a built-in 'node' user (uid 1000).
USER node
EXPOSE 3000
# Migrations run in a dedicated release job (see infra/helm .../migration-job.yaml),
# NOT at app startup — multiple replicas racing migrations on deploy is unsafe.
CMD ["node", "packages/api/dist/bootstrap.js"]
