#!/bin/bash
# Bake script for a worker image, run once on a fresh Ubuntu builder instance by deploy.mjs, which
# fills the double-underscore placeholders. Installs Node, the engine and SCM CLIs, the toolkit and a warm
# clone of the project with its dependencies, then powers off so the instance can be snapshotted.
# The project is cloned over HTTPS with the SCM token read from Parameter Store by the instance
# role; the token is kept in the git credential store for the worker's own fetches and pushes.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
REGION="__REGION__"
SSM_PREFIX="__SSM_PREFIX__"
TOOLKIT_REPO="__TOOLKIT_REPO__"
TOOLKIT_REF="__TOOLKIT_REF__"
PROJECT_HOST="__PROJECT_HOST__"
PROJECT_REPO="__PROJECT_REPO__"
TOKEN_VARIABLE="__TOKEN_VARIABLE__"

apt-get update
apt-get install -y --no-install-recommends git curl ca-certificates unzip build-essential python3 redis-server jq
systemctl disable --now redis-server || true
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip
GLAB_VERSION="$(curl -fsSL https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases | jq -r '.[0].tag_name' | sed 's/^v//')"
curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_amd64.tar.gz" | tar -xz -C /usr/local/bin glab
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt-get update && apt-get install -y gh
npm install -g @anthropic-ai/claude-code opencode-ai @openai/codex
curl -fsSL https://cursor.com/install | bash || true
install -m 755 /root/.local/bin/agent /usr/local/bin/agent 2>/dev/null || true

id agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash agent
# A branch, a tag or a commit: pin a commit so a later push to the toolkit cannot change what runs here.
git clone "${TOOLKIT_REPO}" /opt/agent-team
git -C /opt/agent-team checkout "${TOOLKIT_REF}"
chown -R agent:agent /opt/agent-team

# Tracing stays off while the token is in hand: this output reaches the instance console log.
set +x
TOKEN="$(aws ssm get-parameter --region "${REGION}" --with-decryption --name "${SSM_PREFIX}/${TOKEN_VARIABLE}" --query Parameter.Value --output text)"
install -d -m 700 -o agent -g agent /home/agent
sudo -u agent -H git config --global credential.helper store
printf 'https://oauth2:%s@%s\n' "${TOKEN}" "${PROJECT_HOST}" > /home/agent/.git-credentials
chown agent:agent /home/agent/.git-credentials && chmod 600 /home/agent/.git-credentials
unset TOKEN
set -x
mkdir -p /srv && chown agent:agent /srv
sudo -u agent -H git clone "https://${PROJECT_HOST}/${PROJECT_REPO}.git" /srv/project
sudo -u agent -H bash -lc 'cd /srv/project && __PROJECT_SETUP__'
mkdir -p /var/lib/agent-team /etc/agent-team && chown agent:agent /var/lib/agent-team /etc/agent-team

cloud-init clean --logs || true
rm -rf /tmp/* /root/.npm /home/agent/.npm/_logs
shutdown -h now
