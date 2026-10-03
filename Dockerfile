FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .

RUN npm run build:ui && npm prune --omit=dev

ENV NODE_ENV=production
ENV DATA_DIR=/data

RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "server.js"]
