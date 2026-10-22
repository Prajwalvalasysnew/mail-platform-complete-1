FROM node:22-alpine AS base
WORKDIR /app

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
RUN --mount=type=cache,target=/root/.npm npm ci --workspaces --include-workspace-root
COPY infra/migrations ./infra/migrations
COPY packages ./packages
RUN npm run build --workspace=@platform/shared
RUN npm run build --workspace=@platform/worker
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-alpine
WORKDIR /app
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --chown=node:node --from=base /app /app
USER node
# Migrations run in a dedicated release job, not at app startup.
CMD ["node", "packages/worker/dist/bootstrap.js"]
