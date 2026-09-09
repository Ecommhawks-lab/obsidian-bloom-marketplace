# Obsidian Bloom marketplace — container image.
# Data lives in Turso (libSQL), a pure-JS client, so no native build toolchain is needed.
FROM node:20-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=8890
EXPOSE 8890

CMD ["node", "server.mjs"]
