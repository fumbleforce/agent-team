#!/bin/bash
# User data for a single EC2 control-plane host. Installs Node 24, git and the AWS CLI, clones the toolkit, builds the web
# app, mounts the data volume and runs one process on one port as a systemd service. Secrets are read from Parameter Store
# under SSM_PREFIX at start-up. The host is reached through a Session Manager tunnel to port 4310; nothing is public.
set -euo pipefail

TOOLKIT_REPO="${TOOLKIT_REPO:-https://github.com/fumbleforce/agent-team.git}"
TOOLKIT_REF="${TOOLKIT_REF:-main}"
DATA_DEVICE="${DATA_DEVICE:-/dev/xvdf}"
SSM_PREFIX="${SSM_PREFIX:-/agent-team}"

dnf install -y git unzip tar gzip
curl -fsSL https://rpm.nodesource.com/setup_24.x | bash -
dnf install -y nodejs
if ! command -v aws >/dev/null; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip
  unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip
fi

# Durable data on a separate volume so the instance can be replaced.
mkdir -p /data
if [ -b "$DATA_DEVICE" ]; then
  blkid "$DATA_DEVICE" >/dev/null 2>&1 || mkfs.xfs "$DATA_DEVICE"
  grep -q "$DATA_DEVICE" /etc/fstab || echo "$DATA_DEVICE /data xfs defaults,nofail 0 2" >> /etc/fstab
  mount -a
fi
chmod 700 /data

id agent-team >/dev/null 2>&1 || useradd --system --home /opt/agent-team --shell /usr/sbin/nologin agent-team
# A branch, a tag or a commit: pin a commit so a later push to the toolkit cannot change what runs here.
if [ ! -d /opt/agent-team/.git ]; then git clone "$TOOLKIT_REPO" /opt/agent-team && git -C /opt/agent-team checkout "$TOOLKIT_REF"; fi
(cd /opt/agent-team && npm ci && npm run build:web && npm prune --omit=dev)
chown -R agent-team:agent-team /opt/agent-team /data

IMDS_TOKEN="$(curl -fs -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token || true)"
cat > /etc/agent-team.env <<EOF
AGENT_TEAM_DATA=/data
AGENT_TEAM_SSM_PREFIX=${SSM_PREFIX}
AWS_REGION=$(curl -fs -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN}" http://169.254.169.254/latest/meta-data/placement/region || echo eu-north-1)
EOF
chmod 600 /etc/agent-team.env

cat > /etc/systemd/system/agent-team.service <<'EOF'
[Unit]
Description=Agent team control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent-team
WorkingDirectory=/opt/agent-team
EnvironmentFile=/etc/agent-team.env
ExecStart=/usr/bin/node adapters/hosting/aws/entrypoint.ts
Restart=always
RestartSec=10
TimeoutStopSec=45
KillMode=mixed
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now agent-team.service
