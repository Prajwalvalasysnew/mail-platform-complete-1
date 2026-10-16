# Multi-stage build for the documentation site
# Stage 1: build
FROM node:22-alpine AS builder
WORKDIR /repo

# Copy workspace files. npm workspaces requires EVERY workspace's
# package.json to be present for `npm ci` to resolve the lockfile — copying
# only docs+shared makes the install fail before it starts.
COPY package.json package-lock.json .npmrc ./
COPY packages/docs/package.json ./packages/docs/
COPY packages/shared/package.json ./packages/shared/
COPY packages/api/package.json ./packages/api/
COPY packages/worker/package.json ./packages/worker/
COPY packages/tracker/package.json ./packages/tracker/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/tests/package.json ./packages/tests/
COPY packages/admin-console/package.json ./packages/admin-console/
COPY packages/customer-ui/package.json ./packages/customer-ui/
COPY packages/landing-page/package.json ./packages/landing-page/
COPY packages/haraka-inbound/package.json ./packages/haraka-inbound/
COPY packages/haraka-outbound/package.json ./packages/haraka-outbound/
COPY packages/smtp-gateway/package.json ./packages/smtp-gateway/

# Install all workspace deps
RUN npm ci --ignore-scripts

# Copy source
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/docs ./packages/docs
COPY docs ./docs

# Export OpenAPI spec then build the static site
ARG DOCS_URL=https://docs.yourplatform.com
ENV DOCS_URL=${DOCS_URL}

RUN npm run export-openapi
RUN npm run build --workspace=@platform/docs

# Stage 2: serve with nginx
FROM nginx:1.27-alpine AS runner
COPY --from=builder /repo/packages/docs/build /usr/share/nginx/html
COPY packages/docs/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
