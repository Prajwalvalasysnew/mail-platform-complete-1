FROM node:22-alpine

WORKDIR /app

COPY packages/haraka-inbound/package.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm install --omit=dev \
    && apk del .build-deps \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY packages/haraka-inbound/config ./config
COPY packages/haraka-inbound/plugins ./plugins

RUN mkdir -p queue
RUN chown -R node:node /app

USER node

EXPOSE 2526

CMD ["./node_modules/.bin/haraka", "-c", "."]
