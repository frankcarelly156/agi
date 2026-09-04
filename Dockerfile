FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY . .

RUN chown -R node:node /app

USER node

CMD ["npm", "start"]
