FROM node:22.21.1-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl unzip \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip \
  && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json roles.json OWNER_PREFERENCES.md ./
COPY core ./core
COPY adapters ./adapters
COPY agents ./agents
COPY portraits ./portraits
ENV NODE_ENV=production
ENV AGENT_TEAM_DATA=/data
VOLUME ["/data"]
EXPOSE 4310 4311
CMD ["node", "adapters/hosting/aws/entrypoint.mjs"]
