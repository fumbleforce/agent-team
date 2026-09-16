FROM node:22.21.1-slim
WORKDIR /app
COPY package.json ./
COPY *.mjs ./
COPY agents ./agents
COPY portraits ./portraits
COPY OWNER_PREFERENCES.md opencode.json ./
ENV NODE_ENV=production
CMD ["node", "fly-entrypoint.mjs"]
