FROM node:22-alpine

WORKDIR /app

COPY packages/haraka-outbound/package.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ openssl \
    && npm install --omit=dev

COPY packages/haraka-outbound/config ./config
COPY packages/haraka-outbound/plugins ./plugins

# Haraka queue directory (owned by root; Haraka requires write access at runtime)
RUN mkdir -p queue

# Generate self-signed TLS cert so outbound TLS init doesn't block delivery
RUN openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout config/tls_key.pem -out config/tls_cert.pem -days 3650 \
    -subj "/CN=mail.happycubing.com" \
    && apk del .build-deps \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

RUN chown -R node:node /app

USER node

EXPOSE 2525

CMD ["./node_modules/.bin/haraka", "-c", "."]
