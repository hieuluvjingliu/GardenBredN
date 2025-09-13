# ---- Build stage
FROM node:20-bullseye AS build
WORKDIR /app

# better-sqlite3 cần toolchain
RUN apt-get update -qq &&     apt-get install -y --no-install-recommends build-essential python3 pkg-config &&     rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
# Nếu có bước build client thì bật:
# RUN npm run build

# ---- Runtime stage
FROM node:20-bullseye
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# DB sẽ nằm trên volume /data
ENV DB_PATH=/data/game.db

COPY --from=build /app /app
EXPOSE 3000
CMD ["node", "server.js"]
