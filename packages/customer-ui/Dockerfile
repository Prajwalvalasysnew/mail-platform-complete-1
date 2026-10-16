FROM node:22-alpine AS build
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
RUN --mount=type=cache,target=/root/.npm npm ci --workspace=@platform/customer-ui --include-workspace-root=false
COPY packages/customer-ui packages/customer-ui
RUN npm run build --workspace=@platform/customer-ui

FROM nginx:stable-alpine
RUN apk upgrade --no-cache && sed -i -e 's@/var/run/nginx.pid@/tmp/nginx.pid@g' -e 's@/run/nginx.pid@/tmp/nginx.pid@g' /etc/nginx/nginx.conf
ENV API_UPSTREAM=api:3000 UI_LISTEN_PORT=80 NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 NGINX_ENVSUBST_FILTER="^(API_UPSTREAM|UI_LISTEN_PORT|NGINX_LOCAL_RESOLVERS)$"
COPY packages/customer-ui/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/packages/customer-ui/dist/ /usr/share/nginx/html/
EXPOSE 80
