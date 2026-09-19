FROM node:24-slim AS web
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY adapters/storage ./adapters/storage
RUN npm ci && npm run build -w @agent-team/web

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY packages ./packages
COPY adapters ./adapters
COPY blueprints ./blueprints
RUN npm ci --omit=dev
COPY --from=web /app/packages/web/dist ./packages/web/dist
CMD ["node", "adapters/hosting/fly/entrypoint.ts"]
