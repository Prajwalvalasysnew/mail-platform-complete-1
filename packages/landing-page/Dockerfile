FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
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
RUN --mount=type=cache,target=/root/.npm npm ci --workspace=@platform/landing-page --include-workspace-root=false
COPY packages/landing-page packages/landing-page
ARG API_ORIGIN=http://api:3000
ARG NEXT_PUBLIC_CUSTOMER_UI_URL=http://localhost:8080
ENV API_ORIGIN=$API_ORIGIN NEXT_PUBLIC_CUSTOMER_UI_URL=$NEXT_PUBLIC_CUSTOMER_UI_URL
RUN npm run build --workspace=@platform/landing-page

FROM node:22-alpine
WORKDIR /app
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --chown=node:node --from=build /app/packages/landing-page/.next/standalone ./
USER node
EXPOSE 3000
CMD ["node","packages/landing-page/server.js"]
