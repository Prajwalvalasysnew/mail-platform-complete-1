FROM node:20-alpine

WORKDIR /app

# Haraka needs some build tooling
RUN apk add --no-cache python3 make g++
# openssl is separate so the above layer stays cached on rebuilds
RUN apk add --no-cache openssl

COPY packages/haraka-outbound/package.json ./
RUN npm install

COPY packages/haraka-outbound/config ./config
COPY packages/haraka-outbound/plugins ./plugins

# Haraka queue directory (owned by root; Haraka requires write access at runtime)
RUN mkdir -p queue
# NOTE: Haraka must run as root to bind the SMTP port and write queue files.
# Mitigate with a restrictive PodSecurityContext (readOnlyRootFilesystem: false,
# allowPrivilegeEscalation: false) on the k8s pod rather than USER here.

# Generate self-signed TLS cert so outbound TLS init doesn't block delivery
RUN openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout config/tls_key.pem -out config/tls_cert.pem -days 3650 \
    -subj "/CN=mail.happycubing.com"

EXPOSE 2525

CMD ["./node_modules/.bin/haraka", "-c", "."]
