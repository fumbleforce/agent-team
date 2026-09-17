#!/bin/bash
# Builds a worker AMI for one project: a base Ubuntu image with Node, the engine CLIs, glab/gh, the
# agent-team toolkit and a warm clone of the project with dependencies installed, so an ephemeral
# worker only fetches the latest base branch before it runs. Intended to run nightly from CI or a
# scheduled task on the control plane.
#
#   AWS_REGION=eu-north-1 SUBNET_ID=subnet-... SECURITY_GROUP_ID=sg-... \
#   PROJECT_REPO=git@gitlab.com:hubro/manti.git PROJECT_NAME=manti \
#   DEPLOY_KEY_SSM=/agent-team/manti/deploy-key \
#   ./build-worker-ami.sh
#
# Output: the new AMI id on stdout and an SSM parameter <AMI_PARAMETER> updated to point at it, so
# .agent-team.json can reference the parameter instead of a hard-coded ami id.
set -euo pipefail

: "${AWS_REGION:?set AWS_REGION}"
: "${SUBNET_ID:?set SUBNET_ID}"
: "${SECURITY_GROUP_ID:?set SECURITY_GROUP_ID}"
: "${PROJECT_REPO:?set PROJECT_REPO}"
: "${PROJECT_NAME:?set PROJECT_NAME}"
DEPLOY_KEY_SSM="${DEPLOY_KEY_SSM:-}"
TOOLKIT_REPO="${TOOLKIT_REPO:-https://github.com/fumbleforce/agent-team.git}"
TOOLKIT_REF="${TOOLKIT_REF:-main}"
INSTANCE_TYPE="${INSTANCE_TYPE:-c6i.2xlarge}"
INSTANCE_PROFILE="${INSTANCE_PROFILE:-agent-team-worker}"
AMI_PARAMETER="${AMI_PARAMETER:-/agent-team/${PROJECT_NAME}/worker-ami}"
VOLUME_GB="${VOLUME_GB:-60}"
KEEP_AMIS="${KEEP_AMIS:-3}"
PROJECT_SETUP="${PROJECT_SETUP:-SKIP_INFRA=1 npm run setup}"

# Latest Ubuntu 24.04 LTS AMI published by Canonical.
BASE_AMI="$(aws ssm get-parameter --region "$AWS_REGION" --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)"
STAMP="$(date -u +%Y%m%d-%H%M)"

# The bake script runs once on the builder instance, then powers it off so we can snapshot it.
BAKE="$(cat <<EOF
#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends git curl ca-certificates unzip build-essential python3 redis-server jq
systemctl disable --now redis-server || true
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip && unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip
# SCM CLIs: glab for GitLab projects, gh for GitHub projects; both are small.
GLAB_VERSION="\$(curl -fsSL https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases | jq -r '.[0].tag_name' | sed 's/^v//')"
curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v\${GLAB_VERSION}/downloads/glab_\${GLAB_VERSION}_linux_amd64.tar.gz" | tar -xz -C /usr/local/bin glab
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
apt-get update && apt-get install -y gh
# Engine CLIs. Each adapter's BIN must be on PATH; the manifest decides which one a job uses.
npm install -g @anthropic-ai/claude-code opencode-ai @openai/codex
curl -fsSL https://cursor.com/install | bash || true
install -m 755 /root/.local/bin/agent /usr/local/bin/agent 2>/dev/null || true

id agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash agent
git clone --branch "${TOOLKIT_REF}" "${TOOLKIT_REPO}" /opt/agent-team
chown -R agent:agent /opt/agent-team

# Deploy key for the project clone, fetched from SSM by the instance role and kept for the worker.
if [ -n "${DEPLOY_KEY_SSM}" ]; then
  install -d -m 700 -o agent -g agent /home/agent/.ssh
  aws ssm get-parameter --region "${AWS_REGION}" --with-decryption --name "${DEPLOY_KEY_SSM}" --query Parameter.Value --output text > /home/agent/.ssh/id_ed25519
  chmod 600 /home/agent/.ssh/id_ed25519 && chown agent:agent /home/agent/.ssh/id_ed25519
  ssh-keyscan gitlab.com github.com >> /home/agent/.ssh/known_hosts 2>/dev/null
  chown agent:agent /home/agent/.ssh/known_hosts
fi
sudo -u agent -H bash -c 'git clone "${PROJECT_REPO}" /srv/project' || { mkdir -p /srv && sudo -u agent -H git clone "${PROJECT_REPO}" /srv/project; }
chown -R agent:agent /srv/project
# Project dependencies are installed with the project's own setup so Meteor, npm packages and
# tool caches are already warm on the image.
sudo -u agent -H bash -lc 'cd /srv/project && ${PROJECT_SETUP}'
mkdir -p /var/lib/agent-team /etc/agent-team && chown agent:agent /var/lib/agent-team /etc/agent-team

# The worker service the launcher's user-data starts with --once --job.
cat > /etc/systemd/system/agent-team-worker@.service <<'UNIT'
[Unit]
Description=Agent team ephemeral worker for job %i
After=network-online.target
[Service]
Type=oneshot
User=agent
WorkingDirectory=/opt/agent-team
EnvironmentFile=/etc/agent-team/worker.env
ExecStart=/usr/bin/node core/worker.mjs --config /etc/agent-team/worker.json --once --job %i
UNIT
cloud-init clean --logs || true
rm -rf /tmp/* /root/.npm /home/agent/.npm/_logs
shutdown -h now
EOF
)"

echo "Launching builder from ${BASE_AMI}" >&2
INSTANCE_ID="$(aws ec2 run-instances --region "$AWS_REGION" --image-id "$BASE_AMI" --instance-type "$INSTANCE_TYPE" \
  --subnet-id "$SUBNET_ID" --security-group-ids "$SECURITY_GROUP_ID" --iam-instance-profile "Name=${INSTANCE_PROFILE}" \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":${VOLUME_GB},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --metadata-options HttpTokens=required,HttpEndpoint=enabled \
  --instance-initiated-shutdown-behavior stop \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=agent-team-ami-builder-${PROJECT_NAME}},{Key=agent-team:role,Value=ami-builder}]" \
  --user-data "$BAKE" --query 'Instances[0].InstanceId' --output text)"
echo "Builder ${INSTANCE_ID} baking; waiting for it to stop" >&2
aws ec2 wait instance-stopped --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"

AMI_ID="$(aws ec2 create-image --region "$AWS_REGION" --instance-id "$INSTANCE_ID" --name "agent-team-worker-${PROJECT_NAME}-${STAMP}" \
  --description "agent-team worker for ${PROJECT_NAME} built ${STAMP}" \
  --tag-specifications "ResourceType=image,Tags=[{Key=agent-team:project,Value=${PROJECT_NAME}},{Key=agent-team:built,Value=${STAMP}}]" \
  --query ImageId --output text)"
aws ec2 wait image-available --region "$AWS_REGION" --image-ids "$AMI_ID"
aws ec2 terminate-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" >/dev/null
aws ssm put-parameter --region "$AWS_REGION" --name "$AMI_PARAMETER" --type String --overwrite --value "$AMI_ID" >/dev/null

# Keep the newest KEEP_AMIS images for this project; deregister older ones and their snapshots.
OLD="$(aws ec2 describe-images --region "$AWS_REGION" --owners self --filters "Name=tag:agent-team:project,Values=${PROJECT_NAME}" \
  --query "sort_by(Images,&CreationDate)[:-${KEEP_AMIS}].[ImageId,BlockDeviceMappings[0].Ebs.SnapshotId]" --output text)"
while read -r image snapshot; do
  [ -n "$image" ] || continue
  aws ec2 deregister-image --region "$AWS_REGION" --image-id "$image"
  [ -n "$snapshot" ] && [ "$snapshot" != "None" ] && aws ec2 delete-snapshot --region "$AWS_REGION" --snapshot-id "$snapshot" || true
done <<< "$OLD"

echo "$AMI_ID"
