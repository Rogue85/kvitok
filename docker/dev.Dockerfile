# Development image: Node and pnpm. The code is mounted from the host, the deps service installs dependencies
# into named volumes (native modules are built for Linux and never mix with the host's node_modules).
FROM node:26-bookworm-slim

# openssl — for the Prisma schema engine (migrate).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The pnpm version comes from packageManager, as on the host. Node 25+ ships without corepack, so install it with npm.
COPY package.json /tmp/package.json
RUN npm install -g "$(node -p "require('/tmp/package.json').packageManager")" && rm /tmp/package.json

WORKDIR /app
