FROM node:22-bookworm-slim

WORKDIR /app

# Required for better-sqlite3 / node-gyp
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data && chown -R node:node /app

USER node

CMD ["npm", "start"]