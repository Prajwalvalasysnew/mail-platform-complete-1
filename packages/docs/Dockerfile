# Multi-stage build for the documentation site
# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /repo

# Copy workspace files
COPY package.json package-lock.json ./
COPY packages/docs/package.json ./packages/docs/
COPY packages/shared/package.json ./packages/shared/

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
