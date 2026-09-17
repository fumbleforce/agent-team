#!/bin/bash
# User data for a single EC2 control-plane host (the cheaper alternative to ECS). Installs Node,
# git, the AWS CLI and glab, clones the toolkit, mounts the data volume and runs the entrypoint as
# a systemd service. Secrets are read from SSM under AGENT_TEAM_SSM_PREFIX at start-up.
#
# Replace the CHANGEME values or pass them through instance tags/parameters before launching.
set -euo pipefail

TOOLKIT_REPO="${TOOLKIT_REPO:-https://github.com/fumbleforce/agent-team.git}"
TOOLKIT_REF="${TOOLKIT_REF:-main}"
DATA_DEVICE="${DATA_DEVICE:-/dev/xvdf}"
SSM_PREFIX="${SSM_PREFIX:-/agent-team}"
PROJECTS_JSON="${PROJECTS_JSON:-{\"my-project\":{\"repository\":\"group/project\"}}}"
LAUNCHER_JSON="${LAUNCHER_JSON:-}"
PM_ENGINE="${PM_ENGINE:-claude}"
PM_BILLING="${PM_BILLING:-bedrock}"

dnf install -y git unzip tar gzip
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
dnf install -y nodejs
if ! command -v aws >/dev/null; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip
  unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip
fi
# glab is used by the resident PM for read-only merge request inspection.
GLAB_VERSION="$(curl -fsSL https://api.github.com/repos/gitlab-org/cli/releases/latest | grep -o '"tag_name": *"v[^"]*"' | head -1 | sed 's/.*"v\([^"]*\)"/\1/')"
curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar -xz -C /usr/local/bin glab || true

# Durable data on a separate EBS volume so the instance can be replaced.
mkdir -p /data
if [ -b "$DATA_DEVICE" ]; then
  blkid "$DATA_DEVICE" >/dev/null 2>&1 || mkfs.xfs "$DATA_DEVICE"
  grep -q "$DATA_DEVICE" /etc/fstab || echo "$DATA_DEVICE /data xfs defaults,nofail 0 2" >> /etc/fstab
  mount -a
fi
chmod 700 /data

id agent-team >/dev/null 2>&1 || useradd --system --home /opt/agent-team --shell /usr/sbin/nologin agent-team
if [ ! -d /opt/agent-team/.git ]; then git clone --branch "$TOOLKIT_REF" "$TOOLKIT_REPO" /opt/agent-team; fi
chown -R agent-team:agent-team /opt/agent-team /data

cat > /etc/agent-team.env <<EOF
AGENT_TEAM_DATA=/data
AGENT_TEAM_HOSTNAME=aws
AGENT_TEAM_SSM_PREFIX=${SSM_PREFIX}
AGENT_TEAM_PROJECTS=${PROJECTS_JSON}
AGENT_TEAM_PM_ENGINE=${PM_ENGINE}
AGENT_TEAM_PM_BILLING=${PM_BILLING}
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=$(curl -fs http://169.254.169.254/latest/meta-data/placement/region || echo eu-north-1)
EOF
if [ -n "$LAUNCHER_JSON" ]; then echo "AGENT_TEAM_LAUNCHER=${LAUNCHER_JSON}" >> /etc/agent-team.env; fi
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
ExecStart=/usr/bin/node adapters/hosting/aws/entrypoint.mjs
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
