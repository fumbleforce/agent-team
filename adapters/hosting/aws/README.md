# AWS hosting

The control plane on AWS: one process (`packages/coordinator/src/main.ts` behind `entrypoint.ts`) serving the API, the live stream, the agents' tool endpoint and the web app on port 4310. Workers (`packages/worker/src/main.ts`) run from a baked image and connect outbound to that port.

| File | Purpose |
| --- | --- |
| `entrypoint.ts` | Reads secrets from Parameter Store into the environment and starts the control plane (`../shared/controlPlane.ts`) |
| `deploy.ts` | Idempotent deployment plan: secrets, network, IAM, control-plane host, worker image, verification, and `destroy` |
| `control-plane-user-data.sh` | User data for the single EC2 host: Node 24, the toolkit, the web build, `/data`, `agent-team.service` |
| `worker-bake.sh` | Bake script for the worker image, filled by `bakeScript` in `deploy.ts` |
| `Dockerfile`, `ecs-task-definition.json` | The same entrypoint as a container on ECS Fargate |

## What `deploy` does

`deploy(deployment, options)` takes a deployment object (`newDeployment(facts, { region })`, never holding a secret value) and runs `STEPS` in order, calling `save` after discovery and after every step so a rerun after a failure continues where it stopped. Each step looks for what it would create (by recorded id, then by name or tag) before creating it. The `aws` runner is injectable, which is how `deploy.test.ts` exercises the whole plan without an account. `only` and `skip` select steps. A `DeployError` carries a `hint` a person can act on.

1. **secrets**: values go to SSM Parameter Store under `/agent-team/<project>/`, the machine token (`AGENT_TEAM_TOKEN`, `scope: 'control'`) under `/agent-team/<project>/control/`. Stored values are never overwritten unless `replace` names them; an optional secret nobody provided is skipped.
2. **network**: a dedicated VPC with one public subnet, placed in the data volume's zone when one survives (`network: 'default'` uses the account's default VPC instead), and one security group.
3. **iam**: roles `agent-team-<project>-control` and `agent-team-<project>-worker` with inline policies from `rolePolicies`.
4. **controlPlane**: a `t3.small` on Amazon Linux 2023 with a persistent `/data` volume that is re-attached when the host is replaced.
5. **image**: a worker AMI baked from Ubuntu 24.04, published to `/agent-team/<project>/worker-ami`, older images pruned (`keep`, default 3).
6. **verify**: waits for the host to register with Session Manager and, when a `probe` is given, for a tunnelled `GET /health` on 4310. With `access: 'public'` it requests `http://<public ip>:4310/health` directly.

There is no generated sign-in password. On first start the control plane writes a one-time setup link to the service log (`journalctl -u agent-team.service`, or the task's CloudWatch stream); the first visitor uses it to create the owner account.

The host is reached through a Session Manager port-forward to 4310, which needs the Session Manager plugin for the AWS CLI. `access: 'public'` in the deployment admits the deployer's address (`myIp`) to the plain-HTTP port instead; put an ALB with a certificate in front and set `AGENT_TEAM_PUBLIC_URL` to its `https://` address so cookies are marked secure.

Hosts run the toolkit revision recorded in `deployment.toolkit` (`{ repo, ref }`, default the `main` branch). Pin a commit so a later push to the toolkit repository cannot change what runs in your account.

## Isolation from the rest of the account

Shell commands a model runs on a worker share the worker's Unix account, so they can use the worker's instance role and read the project's tracker key and SCM token. The boundary is therefore what a worker as a whole can reach:

- **Worker role:** parameters directly under its project prefix (an explicit deny covers `control/` and every parameter outside the prefix), decryption only through Parameter Store for those parameters, Bedrock model invocation, and uploads to `agent-team-*` buckets of the same account. No EC2, IAM or Session Manager permissions; the managed `AmazonSSMManagedInstanceCore` policy is not attached because it reads every parameter in the account, and is detached when an earlier version attached it.
- **Control role:** the same, plus Session Manager for the owner's tunnels. It launches instances only from images tagged `agent-team:project=<project>`, only into the deployment's subnet, only with that tag, tags only at launch, and terminates only instances carrying the tag. `iam:PassRole` is limited to the worker role and EC2.
- **Permissions boundary:** `permissionsBoundary` (a policy ARN) is attached to both roles at creation; deploy stops if an existing role lacks it, and explains the setting when role creation is denied.
- **Network:** hosts live in their own VPC with no route to other networks in the account. The security group admits only port 4310 from inside the group; outbound is limited to ports 80 and 443 and port 4310 inside the group (`aws.egressPorts` changes the list, for example to add 22 for dependencies fetched over SSH). All hosts require IMDSv2 with a hop limit of 1.
- **Bake:** the SCM token is read with shell tracing off, so it does not reach the instance console log.

What this does not cover: outbound HTTPS is unrestricted, so a worker can send what it can read (source, the tracker key, the SCM token) anywhere. Give the SCM token the narrowest role that can push branches and open merge requests, protect the base branch so merging needs passing pipelines, and scope the tracker key to the team. Bedrock invocation is not limited by model or spend; set an AWS budget alarm on the `agent-team:project` tag.

`destroy` terminates the project's instances, removes its images, the image parameter, the security group and a dedicated network. The data volume (the database), the secrets and the roles are removed only with `removeData`, `removeSecrets` and `removeRoles`.

## By hand

Two options, same `entrypoint.ts`:

- **Single EC2 host** (cheapest): launch a `t3.small` with an attached EBS data volume at `/dev/xvdf` and `control-plane-user-data.sh` as user data (`TOOLKIT_REPO`, `TOOLKIT_REF`, `SSM_PREFIX` and `DATA_DEVICE` may be exported ahead of it). The script installs Node 24, clones the toolkit, builds the web app, mounts `/data` and runs the entrypoint as `agent-team.service`.
- **ECS Fargate service**: build `Dockerfile` from the repository root (`docker build -f adapters/hosting/aws/Dockerfile .`), push to ECR, register `ecs-task-definition.json` with the placeholders replaced, and create a service with one task and an EFS volume for `/data`. The container health check requests `/health` on 4310.

Secrets are read from Parameter Store under `AGENT_TEAM_SSM_PREFIX` and then `<prefix>/control`, the latter winning; every parameter becomes an environment variable named after its last path segment. `AGENT_TEAM_TOKEN` is required. The task or instance role needs `ssm:GetParametersByPath` on that path plus `kms:Decrypt`; `rolePolicies` in `deploy.ts` is the reference for both roles.

| Variable | Purpose |
| --- | --- |
| `AGENT_TEAM_SSM_PREFIX`, `AWS_REGION` | Where the secrets are (both required) |
| `AGENT_TEAM_DATA` | Durable directory, default `/data`; holds `coordinator.sqlite` |
| `AGENT_TEAM_DATABASE_URL` | Use Postgres instead of SQLite |
| `AGENT_TEAM_PUBLIC_URL` | The address people use, for the setup link and secure cookies (default `http://127.0.0.1:4310`, the tunnel) |
| `PORT` | Listening port, default 4310 |

## Workers

`worker-bake.sh` produces the image: Ubuntu, Node 24, the engine CLIs (`claude`, `opencode`, `codex`, `agent`), `glab`/`gh`, the toolkit with its dependencies at `/opt/agent-team`, and a warm clone at `/srv/project` with the project's own setup already run. It installs `agent-team-worker.service`, which runs `node packages/worker/src/main.ts --config /etc/agent-team/worker.json` as the unprivileged `agent` account once that file exists; `/etc/agent-team/worker.env` supplies `AGENT_TEAM_TOKEN` and the project's credentials. Whoever launches an instance from the image writes both files in its user data, with `coordinatorUrl` set to `http://<control plane private ip>:4310`.

The worker instance profile needs what `rolePolicies(deployment).worker` grants: `ssm:GetParametersByPath` on its prefix, `bedrock:InvokeModel*` when the engine bills through Bedrock, and `s3:PutObject` on the artifacts bucket.
