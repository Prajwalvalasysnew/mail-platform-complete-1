FROM node:20-alpine AS base
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY infra/migrations ./infra/migrations
COPY packages/shared ./packages/shared
COPY packages/tracker ./packages/tracker

RUN npm install --workspaces --include-workspace-root
RUN npm run build --workspace=@platform/shared
RUN npm run build --workspace=@platform/tracker

FROM node:20-alpine
WORKDIR /app
COPY --from=base /app /app
RUN chown -R node:node /app
USER node
EXPOSE 4000
# Migrations run in a dedicated release job, not at app startup.
CMD ["node", "packages/tracker/dist/server.js"]
