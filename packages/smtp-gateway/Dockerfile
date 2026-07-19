FROM node:20-alpine AS base
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY infra/migrations ./infra/migrations
COPY packages ./packages

RUN npm ci --workspaces --include-workspace-root
RUN npm run build --workspace=@platform/shared
RUN npm run build --workspace=@platform/smtp-gateway
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:20-alpine
WORKDIR /app
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=base /app /app
RUN chown -R node:node /app
USER node
EXPOSE 587 9102
# Migrations run in a dedicated release job, not at app startup.
CMD ["node", "packages/smtp-gateway/dist/server.js"]
