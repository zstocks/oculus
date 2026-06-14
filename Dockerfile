FROM node:22-alpine

# better-sqlite3 compiles a native addon; Alpine (musl) needs build tools.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install deps as root (native build needs the toolchain), then drop privileges.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Mount points for the box bind-mounts + local tmp/data, owned by the runtime user.
RUN mkdir -p /app/originals /app/incoming /app/data/tmp \
    && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
