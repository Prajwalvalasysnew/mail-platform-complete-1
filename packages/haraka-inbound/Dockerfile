FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++


COPY packages/haraka-inbound/package.json ./
RUN npm install

COPY packages/haraka-inbound/config ./config
COPY packages/haraka-inbound/plugins ./plugins

RUN mkdir -p queue
RUN chown -R node:node /app

USER node

EXPOSE 2526

CMD ["./node_modules/.bin/haraka", "-c", "."]
