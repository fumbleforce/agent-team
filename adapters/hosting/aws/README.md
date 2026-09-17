# AWS hosting

Control plane (coordinator, tracker intake, resident PM, dashboard) on AWS, ephemeral EC2 workers per job.

## Four commands

From a laptop with the AWS CLI signed in (`aws login`) and the toolkit installed (`npm install -g github:fumbleforce/agent-team`, or `npx` from a checkout):

```bash
agent-team init /path/to/project   # reads .agent-team.json, asks for the tracker key and SCM token once
agent-team deploy                  # roles, network, control plane, worker image; prints the dashboard address
agent-team seed                    # project memory from the checkout's charter and instruction files
agent-team enqueue --issue KEY-1 --publish
```

Then `agent-team status | open | password | logs | image | destroy`. `deploy` and `image` are safe to rerun: each step finds what already exists before creating anything, and progress is recorded in `~/.config/agent-team/<project>.json` (which never contains a secret).

What `init` derives from the manifest so it never has to ask: the project id, the SCM (`gitlab`/`github`), which tokens are needed, the engine and billing, the worker size, the setup command that warms the image (`worker.setup`, default `npm ci`), and the Parameter Store path for the image (`/agent-team/<project>/worker-ami`). From the account: region, default VPC and subnet. Generated: the coordinator token and the dashboard password. The only prompts are the checkout path, the region to confirm, and the credentials.

What `deploy` creates: secrets in SSM Parameter Store under `/agent-team/<project>/`; IAM roles `agent-team-control` (read the secrets, Bedrock, start and stop workers) and `agent-team-worker` (read the secrets, Bedrock, upload artifacts); one security group admitting the dashboard from your current address and the coordinator from inside the group; a `t3.small` control-plane host on Amazon Linux with a persistent `/data` volume that survives relaunches; a worker AMI baked from Ubuntu with Node, the engine CLIs, `glab`/`gh`, the toolkit and a warm clone of the project. The dashboard is plain HTTP with basic auth on port 4311; put an ALB with a certificate in front before anyone else uses it.

`enqueue` and `seed` reach the coordinator through a Session Manager port-forward, so port 4310 never needs to be public; this needs the Session Manager plugin for the AWS CLI.

## By hand

Two options, same `entrypoint.mjs`, if you would rather not use the CLI:

- **Single EC2 host** (cheapest): launch a `t4g.small`/`t3.small` with an attached EBS data volume and `control-plane-user-data.sh` as user data. The script installs Node, clones the toolkit, mounts `/data`, and runs the entrypoint as `agent-team.service`.
- **ECS Fargate service**: build `Dockerfile` from the repository root (`docker build -f adapters/hosting/aws/Dockerfile .`), push to ECR, register `ecs-task-definition.json` with the placeholders replaced, and create a service with one task and an EFS volume for `/data`.

Secrets are read from SSM Parameter Store under `AGENT_TEAM_SSM_PREFIX` (default `/agent-team`): `AGENT_TEAM_TOKEN`, `AGENT_TEAM_DASHBOARD_PASSWORD`, `LINEAR_API_KEY`, and optionally `ANTHROPIC_API_KEY`, `GITLAB_TOKEN`, `GH_TOKEN`. The task or instance role needs `ssm:GetParameters` on that path plus `kms:Decrypt`.

Environment:

| Variable | Purpose |
| --- | --- |
| `AGENT_TEAM_PROJECTS` | JSON registry `{"my-project":{"repository":"group/project"}}` |
| `AGENT_TEAM_PM_ENGINE`, `AGENT_TEAM_PM_BILLING`, `AGENT_TEAM_PM_MODEL` | Resident PM engine (`claude` + `bedrock` uses the role's credentials) |
| `AGENT_TEAM_LAUNCHER` | JSON `{"kind":"ec2","options":{...}}` shared launcher options; manifests refine `worker.*` |
| `AGENT_TEAM_CLAIM_TIMEOUT_MINUTES` | Watchdog: unclaimed launched jobs fail and their instance is terminated |
| `AGENT_TEAM_DATA` | Durable directory (queue SQLite, memory git repo, PM state) |

Expose the dashboard (4311) behind an ALB with HTTPS; the coordinator API (4310) only needs to be reachable from workers (same VPC or a private ALB listener). Both ports authenticate on their own (basic auth and bearer token).

## Workers

`agent-team image` bakes a project image with `worker-bake.sh`: Ubuntu, Node, engine CLIs (`claude`, `opencode`, `codex`, `agent`), `glab`/`gh`, the toolkit at `/opt/agent-team`, and a warm clone at `/srv/project` with the project's own setup already run. It publishes the AMI id to SSM (`/agent-team/<project>/worker-ami`), so the manifest can say `"ami": "ssm:/agent-team/my-project/worker-ami"` and nightly rebuilds never touch the manifest. Run `agent-team image` from a scheduled CI job for nightly rebuilds.

Launcher options (`AGENT_TEAM_LAUNCHER.options`):

| Option | Purpose |
| --- | --- |
| `region`, `subnetId`, `securityGroupId`, `instanceProfile` | Where and as whom workers run |
| `coordinatorUrl` | How the worker reaches the coordinator (private DNS or ALB) |
| `ssmPrefix` | Path whose parameters are exported to the worker (`LINEAR_API_KEY`, `GITLAB_TOKEN`, ...) |
| `spot` | Try spot first, fall back to on-demand (default true) |
| `checkout`, `toolkit`, `volumeGb`, `tags` | Image layout and bookkeeping |

The worker instance profile needs `ssm:GetParametersByPath` on its prefix, `bedrock:InvokeModel*` when the engine bills through Bedrock, and `s3:PutObject` on the artifacts bucket when `artifacts.kind` is `s3`. Instances terminate themselves after one job (`InstanceInitiatedShutdownBehavior: terminate`).
