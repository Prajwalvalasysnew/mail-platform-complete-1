FROM node:20-alpine AS base
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY infra/migrations ./infra/migrations
COPY packages/shared ./packages/shared
COPY packages/worker ./packages/worker

RUN npm install --workspaces --include-workspace-root
RUN npm run build --workspace=@platform/shared
RUN npm run build --workspace=@platform/worker

FROM node:20-alpine
WORKDIR /app
COPY --from=base /app /app
RUN chown -R node:node /app
USER node
# Migrations run in a dedicated release job, not at app startup.
CMD ["node", "packages/worker/dist/index.js"]
