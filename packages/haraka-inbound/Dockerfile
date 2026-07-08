FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++


COPY packages/haraka-inbound/package.json ./
RUN npm install

COPY packages/haraka-inbound/config ./config
COPY packages/haraka-inbound/plugins ./plugins

RUN mkdir -p queue

EXPOSE 25

CMD ["./node_modules/.bin/haraka", "-c", "."]
