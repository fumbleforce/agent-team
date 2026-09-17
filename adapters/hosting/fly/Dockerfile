FROM node:22.21.1-slim
WORKDIR /app
COPY package.json roles.json OWNER_PREFERENCES.md ./
COPY core ./core
COPY adapters ./adapters
COPY agents ./agents
COPY portraits ./portraits
ENV NODE_ENV=production
CMD ["node", "adapters/hosting/fly/fly-entrypoint.mjs"]
