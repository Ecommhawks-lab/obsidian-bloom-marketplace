# Obsidian Bloom marketplace — container image
FROM node:20-bookworm-slim

# better-sqlite3 needs a toolchain if a prebuilt binary isn't available
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=8890
ENV DB_PATH=/data/data.sqlite
EXPOSE 8890

# /data should be a mounted volume so the SQLite DB persists across restarts
CMD ["node", "server.mjs"]
