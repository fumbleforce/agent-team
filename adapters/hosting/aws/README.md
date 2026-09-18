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

What `deploy` creates, in this order: secrets in SSM Parameter Store under `/agent-team/<project>/` (the coordinator token and the dashboard password under `/agent-team/<project>/control/`); a dedicated VPC with one public subnet (`init --default-vpc` uses the account's default VPC instead) and one security group; IAM roles `agent-team-<project>-control` and `agent-team-<project>-worker`; a `t3.small` control-plane host on Amazon Linux with a persistent `/data` volume that survives relaunches; a worker AMI baked from Ubuntu with Node, the engine CLIs, `glab`/`gh`, the toolkit and a warm clone of the project. `init` itself creates nothing but the parameters. Deploy finishes once the coordinator answers a health request through a Session Manager tunnel.

`agent-team open` reaches the dashboard through the same kind of tunnel on `127.0.0.1:4311`; `init --public-dashboard` opens the plain-HTTP port to your current address instead, which wants an ALB with a certificate in front.

Hosts run the toolkit revision recorded at `init`: this checkout's commit when `origin/main` already contains it, otherwise the `main` branch, or whatever `--toolkit-ref COMMIT` names. Pin a commit so a later push to the toolkit repository cannot change what runs in your account; rerun `init --toolkit-ref` and `deploy` to move it.

## Isolation from the rest of the account

Shell commands a model runs on a worker share the worker's Unix account, so they can use the worker's instance role, read its user data and read the project's tracker key and SCM token. The boundary is therefore what a worker as a whole can reach:

- **Worker role:** parameters directly under its project prefix (an explicit deny covers `control/` and every parameter outside the prefix), decryption only through Parameter Store for those parameters, Bedrock model invocation, and uploads to `agent-team-*` buckets of the same account. No EC2, IAM or Session Manager permissions; the managed `AmazonSSMManagedInstanceCore` policy is not attached because it reads every parameter in the account.
- **Control role:** the same, plus Session Manager for the owner's tunnels. It launches instances only from images tagged `agent-team:project=<project>`, only into the deployment's subnet, only with that tag, tags only at launch, and terminates only instances carrying the tag. `iam:PassRole` is limited to the worker role and EC2. A worker image built elsewhere needs the tag before the control plane may launch it.
- **Permissions boundary:** `init --permissions-boundary ARN` attaches a boundary to both roles at creation; deploy stops if an existing role lacks it, and explains the flag when role creation is denied.
- **Coordinator access:** a launched worker never sees the coordinator token. Its user data holds a token derived for its one job, which can claim and report that job, record its cost and read its project's settings and memory. Enqueueing, settings, manifest registration, memory writes, messages, other jobs and other projects answer 403, and the token stops working when the job ends. The manifest the coordinator acts on (autonomy, delivery authorization, worker size) comes from the owner's checkout: `deploy`, `seed` and `enqueue` register it through the tunnel.
- **Network:** hosts live in their own VPC with no route to other networks in the account. The security group admits only the coordinator port from inside the group; outbound is limited to ports 80 and 443 and the coordinator (`aws.egressPorts` in the deployment file changes the list, for example to add 22 for dependencies fetched over SSH). All hosts require IMDSv2 with a hop limit of 1.
- **Bake:** the SCM token is read with shell tracing off, so it does not reach the instance console log.

What this does not cover: outbound HTTPS is unrestricted, so a worker can send what it can read (source, the tracker key, the SCM token) anywhere. Give the SCM token the narrowest role that can push branches and open merge requests, protect the base branch on the SCM so merging needs passing pipelines, and scope the tracker key to the team. Bedrock invocation is not limited by model or spend; set an AWS budget alarm on the `agent-team:project` tag.

`enqueue` and `seed` reach the coordinator through a Session Manager port-forward, so port 4310 never needs to be public; this needs the Session Manager plugin for the AWS CLI.

## By hand

Two options, same `entrypoint.mjs`, if you would rather not use the CLI:

- **Single EC2 host** (cheapest): launch a `t4g.small`/`t3.small` with an attached EBS data volume and `control-plane-user-data.sh` as user data. The script installs Node, clones the toolkit, mounts `/data`, and runs the entrypoint as `agent-team.service`.
- **ECS Fargate service**: build `Dockerfile` from the repository root (`docker build -f adapters/hosting/aws/Dockerfile .`), push to ECR, register `ecs-task-definition.json` with the placeholders replaced, and create a service with one task and an EFS volume for `/data`.

Secrets are read from SSM Parameter Store under `AGENT_TEAM_SSM_PREFIX` (default `/agent-team`): `control/AGENT_TEAM_TOKEN` and `control/AGENT_TEAM_DASHBOARD_PASSWORD` (also accepted directly under the prefix, where workers can read them), `LINEAR_API_KEY`, and optionally `ANTHROPIC_API_KEY`, `GITLAB_TOKEN`, `GH_TOKEN`. The task or instance role needs `ssm:GetParameters` on that path plus `kms:Decrypt`; `rolePolicies` in `deploy.mjs` is the reference for both roles. The coordinator issues each launched worker its own job token, so the launcher options carry no token.

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

When creating roles by hand, the worker instance profile needs `ssm:GetParametersByPath` on its prefix, `bedrock:InvokeModel*` when the engine bills through Bedrock, and `s3:PutObject` on the artifacts bucket when `artifacts.kind` is `s3`. Instances terminate themselves after one job (`InstanceInitiatedShutdownBehavior: terminate`).
