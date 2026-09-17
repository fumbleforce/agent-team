#!/bin/bash
# Creates everything a single-host control plane needs and launches it: SSM secrets, an IAM role
# that can read them, start and stop worker instances and call Bedrock, a security group that
# exposes the dashboard to your address only, and one small instance with a separate data volume.
# Idempotent for the IAM and security-group parts; run again with STEP=instance to relaunch only
# the host.
#
#   AGENT_TEAM_TOKEN=... AGENT_TEAM_DASHBOARD_PASSWORD=... LINEAR_API_KEY=... GITLAB_TOKEN=... \
#   PROJECT=manti PROJECT_REPO=hubro/manti ./adapters/hosting/aws/launch-control-plane.sh
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${PROJECT:?PROJECT (queue project id) is required}"
PROJECT_REPO="${PROJECT_REPO:?PROJECT_REPO (group/project on the SCM) is required}"
REGION="${AWS_REGION:-$(aws configure get region)}"
NAME="${NAME:-agent-team}"
SSM_PREFIX="${SSM_PREFIX:-/agent-team}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
DATA_GB="${DATA_GB:-20}"
WORKER_INSTANCE_TYPE="${WORKER_INSTANCE_TYPE:-c6i.2xlarge}"
MY_IP="${MY_IP:-$(curl -fsS https://checkip.amazonaws.com)/32}"
STEP="${STEP:-all}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
VPC="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)}"
SUBNET="${SUBNET_ID:-$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true --query 'Subnets[0].SubnetId' --output text)}"
[ "$VPC" != None ] && [ "$SUBNET" != None ] || { echo "No default VPC/subnet; set VPC_ID and SUBNET_ID" >&2; exit 1; }

put_secret() { [ -n "${!1:-}" ] || return 0; aws ssm put-parameter --name "$SSM_PREFIX/$1" --type SecureString --overwrite --value "${!1}" >/dev/null; echo "ssm $SSM_PREFIX/$1"; }

if [ "$STEP" = all ]; then
  for name in AGENT_TEAM_TOKEN AGENT_TEAM_DASHBOARD_PASSWORD LINEAR_API_KEY GITLAB_TOKEN GH_TOKEN ANTHROPIC_API_KEY; do put_secret "$name"; done
  aws ssm get-parameter --name "$SSM_PREFIX/AGENT_TEAM_TOKEN" >/dev/null 2>&1 || { echo "AGENT_TEAM_TOKEN must exist in SSM or the environment" >&2; exit 1; }
  aws ssm get-parameter --name "$SSM_PREFIX/AGENT_TEAM_DASHBOARD_PASSWORD" >/dev/null 2>&1 || { echo "AGENT_TEAM_DASHBOARD_PASSWORD must exist in SSM or the environment" >&2; exit 1; }

  TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  # Worker role: read its secrets, call Bedrock, upload artifacts.
  aws iam get-role --role-name "$NAME-worker" >/dev/null 2>&1 || aws iam create-role --role-name "$NAME-worker" --assume-role-policy-document "$TRUST" >/dev/null
  aws iam put-role-policy --role-name "$NAME-worker" --policy-name access --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
    {\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\",\"ssm:GetParameters\",\"ssm:GetParametersByPath\"],\"Resource\":\"arn:aws:ssm:$REGION:$ACCOUNT:parameter$SSM_PREFIX/*\"},
    {\"Effect\":\"Allow\",\"Action\":\"kms:Decrypt\",\"Resource\":\"*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"bedrock:InvokeModel\",\"bedrock:InvokeModelWithResponseStream\"],\"Resource\":\"*\"},
    {\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":\"arn:aws:s3:::$NAME-*/*\"}]}"
  aws iam get-instance-profile --instance-profile-name "$NAME-worker" >/dev/null 2>&1 || { aws iam create-instance-profile --instance-profile-name "$NAME-worker" >/dev/null; aws iam add-role-to-instance-profile --instance-profile-name "$NAME-worker" --role-name "$NAME-worker"; }
  # Control-plane role: everything the worker has, plus starting and stopping workers.
  aws iam get-role --role-name "$NAME-control" >/dev/null 2>&1 || aws iam create-role --role-name "$NAME-control" --assume-role-policy-document "$TRUST" >/dev/null
  aws iam put-role-policy --role-name "$NAME-control" --policy-name access --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
    {\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\",\"ssm:GetParameters\",\"ssm:GetParametersByPath\"],\"Resource\":\"arn:aws:ssm:$REGION:$ACCOUNT:parameter$SSM_PREFIX/*\"},
    {\"Effect\":\"Allow\",\"Action\":\"kms:Decrypt\",\"Resource\":\"*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"bedrock:InvokeModel\",\"bedrock:InvokeModelWithResponseStream\"],\"Resource\":\"*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"ec2:RunInstances\",\"ec2:TerminateInstances\",\"ec2:DescribeInstances\",\"ec2:DescribeImages\",\"ec2:CreateTags\",\"ec2:DescribeSpotPriceHistory\"],\"Resource\":\"*\"},
    {\"Effect\":\"Allow\",\"Action\":\"iam:PassRole\",\"Resource\":\"arn:aws:iam::$ACCOUNT:role/$NAME-worker\"}]}"
  aws iam attach-role-policy --role-name "$NAME-control" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam attach-role-policy --role-name "$NAME-worker" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam get-instance-profile --instance-profile-name "$NAME-control" >/dev/null 2>&1 || { aws iam create-instance-profile --instance-profile-name "$NAME-control" >/dev/null; aws iam add-role-to-instance-profile --instance-profile-name "$NAME-control" --role-name "$NAME-control"; sleep 10; }

  SG="$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)"
  if [ "$SG" = None ]; then
    SG="$(aws ec2 create-security-group --group-name "$NAME" --description "agent-team control plane and workers" --vpc-id "$VPC" --query GroupId --output text)"
    aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 4311 --cidr "$MY_IP" >/dev/null
    aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 4310 --source-group "$SG" >/dev/null
  fi
  echo "iam $NAME-control $NAME-worker; sg $SG"
fi

SG="$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME" Name=vpc-id,Values="$VPC" --query 'SecurityGroups[0].GroupId' --output text)"
AMI="$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)"
LAUNCHER="{\"kind\":\"ec2\",\"options\":{\"region\":\"$REGION\",\"subnetId\":\"$SUBNET\",\"securityGroupId\":\"$SG\",\"instanceProfile\":\"$NAME-worker\",\"ssmPrefix\":\"$SSM_PREFIX\",\"instanceType\":\"$WORKER_INSTANCE_TYPE\",\"coordinatorUrl\":\"http://COORDINATOR_HOST:4310\"}}"
USER_DATA="$(mktemp)"
{
  echo '#!/bin/bash'
  echo "export SSM_PREFIX='$SSM_PREFIX' PROJECTS_JSON='{\"$PROJECT\":{\"repository\":\"$PROJECT_REPO\"}}' PM_ENGINE='${PM_ENGINE:-claude}' PM_BILLING='${PM_BILLING:-bedrock}'"
  # The coordinator host name is only known once the instance exists; the launcher options use the
  # instance's own private address.
  echo "LAUNCHER_JSON=\$(echo '$LAUNCHER' | sed \"s/COORDINATOR_HOST/\$(curl -fs http://169.254.169.254/latest/meta-data/local-ipv4)/\"); export LAUNCHER_JSON"
  tail -n +2 control-plane-user-data.sh
} > "$USER_DATA"

INSTANCE="$(aws ec2 run-instances --image-id "$AMI" --instance-type "$INSTANCE_TYPE" --subnet-id "$SUBNET" --security-group-ids "$SG" \
  --iam-instance-profile Name="$NAME-control" --associate-public-ip-address --user-data "file://$USER_DATA" \
  --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":16,\"VolumeType\":\"gp3\"}},{\"DeviceName\":\"/dev/xvdf\",\"Ebs\":{\"VolumeSize\":$DATA_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":false}}]" \
  --metadata-options HttpTokens=optional --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME-control},{Key=agent-team,Value=control}]" \
  --query 'Instances[0].InstanceId' --output text)"
rm -f "$USER_DATA"
aws ec2 wait instance-running --instance-ids "$INSTANCE"
IP="$(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
cat <<MSG
instance $INSTANCE ($IP); bootstrap takes 3-5 minutes
dashboard  http://$IP:4311  (basic auth, password from SSM; allowed from $MY_IP only)
logs       aws ssm start-session --target $INSTANCE   then: sudo journalctl -u agent-team -f
teardown   aws ec2 terminate-instances --instance-ids $INSTANCE   (the /data volume is kept)
MSG
