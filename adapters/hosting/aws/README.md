# AWS hosting

Control plane (coordinator, tracker intake, resident PM, dashboard) on AWS, ephemeral EC2 workers per job.

## Control plane

Quickest route, one command from a laptop with the AWS CLI signed in:

```bash
AGENT_TEAM_TOKEN=$(openssl rand -hex 24) AGENT_TEAM_DASHBOARD_PASSWORD=... LINEAR_API_KEY=... GITLAB_TOKEN=... \
PROJECT=manti PROJECT_REPO=group/manti adapters/hosting/aws/launch-control-plane.sh
```

`launch-control-plane.sh` stores the secrets in SSM, creates the `agent-team-control` and `agent-team-worker` roles and instance profiles, a security group that admits the dashboard from your current address only, and launches one `t3.small` in the default VPC with a persistent `/data` volume. It prints the dashboard URL, how to tail logs over Session Manager, and the teardown command. Rerun with `STEP=instance` to replace just the host.

Two options for doing it by hand, same `entrypoint.mjs`:

- **Single EC2 host** (cheapest): launch a `t4g.small`/`t3.small` with an attached EBS data volume and `control-plane-user-data.sh` as user data. The script installs Node, clones the toolkit, mounts `/data`, and runs the entrypoint as `agent-team.service`.
- **ECS Fargate service**: build `Dockerfile` from the repository root (`docker build -f adapters/hosting/aws/Dockerfile .`), push to ECR, register `ecs-task-definition.json` with the placeholders replaced, and create a service with one task and an EFS volume for `/data`.

Secrets are read from SSM Parameter Store under `AGENT_TEAM_SSM_PREFIX` (default `/agent-team`): `AGENT_TEAM_TOKEN`, `AGENT_TEAM_DASHBOARD_PASSWORD`, `LINEAR_API_KEY`, and optionally `ANTHROPIC_API_KEY`, `GITLAB_TOKEN`, `GH_TOKEN`. The task or instance role needs `ssm:GetParameters` on that path plus `kms:Decrypt`.

Environment:

| Variable | Purpose |
| --- | --- |
| `AGENT_TEAM_PROJECTS` | JSON registry `{"manti":{"repository":"group/project"}}` |
| `AGENT_TEAM_PM_ENGINE`, `AGENT_TEAM_PM_BILLING`, `AGENT_TEAM_PM_MODEL` | Resident PM engine (`claude` + `bedrock` uses the role's credentials) |
| `AGENT_TEAM_LAUNCHER` | JSON `{"kind":"ec2","options":{...}}` shared launcher options; manifests refine `worker.*` |
| `AGENT_TEAM_CLAIM_TIMEOUT_MINUTES` | Watchdog: unclaimed launched jobs fail and their instance is terminated |
| `AGENT_TEAM_DATA` | Durable directory (queue SQLite, memory git repo, PM state) |

Expose the dashboard (4311) behind an ALB with HTTPS; the coordinator API (4310) only needs to be reachable from workers (same VPC or a private ALB listener). Both ports authenticate on their own (basic auth and bearer token).

## Workers

`build-worker-ami.sh` bakes a project image: Ubuntu, Node, engine CLIs (`claude`, `opencode`, `codex`, `agent`), `glab`/`gh`, the toolkit at `/opt/agent-team`, and a warm clone at `/srv/project` with the project's own setup already run. It publishes the AMI id to SSM (`/agent-team/<project>/worker-ami`), so the manifest can say `"ami": "ssm:/agent-team/manti/worker-ami"` and nightly rebuilds never touch the manifest. Run it from a scheduled CI job or a cron on the control plane.

Launcher options (`AGENT_TEAM_LAUNCHER.options`):

| Option | Purpose |
| --- | --- |
| `region`, `subnetId`, `securityGroupId`, `instanceProfile` | Where and as whom workers run |
| `coordinatorUrl` | How the worker reaches the coordinator (private DNS or ALB) |
| `ssmPrefix` | Path whose parameters are exported to the worker (`LINEAR_API_KEY`, `GITLAB_TOKEN`, ...) |
| `spot` | Try spot first, fall back to on-demand (default true) |
| `checkout`, `toolkit`, `volumeGb`, `tags` | Image layout and bookkeeping |

The worker instance profile needs `ssm:GetParametersByPath` on its prefix, `bedrock:InvokeModel*` when the engine bills through Bedrock, and `s3:PutObject` on the artifacts bucket when `artifacts.kind` is `s3`. Instances terminate themselves after one job (`InstanceInitiatedShutdownBehavior: terminate`).
