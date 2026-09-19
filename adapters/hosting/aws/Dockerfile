FROM node:24-slim AS web
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY adapters/storage ./adapters/storage
RUN npm ci && npm run build -w @agent-team/web

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl unzip \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip \
  && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV AGENT_TEAM_DATA=/data
COPY package.json package-lock.json ./
COPY packages ./packages
COPY adapters ./adapters
COPY blueprints ./blueprints
COPY bin ./bin
RUN npm ci --omit=dev
COPY --from=web /app/packages/web/dist ./packages/web/dist
VOLUME ["/data"]
EXPOSE 4310
CMD ["node", "adapters/hosting/aws/entrypoint.ts"]
