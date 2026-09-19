// A fake AWS account for tests: remembers what was created so a second run finds it.
export type State = Record<string, any>; // The fake account is a loose bag of what was created.
export const notFound = (name: string) => new Error(`aws x y: An error occurred (${name})`);

export function fakeAws(state: State = {}) {
  const calls: string[][] = [];
  state.parameters ??= {}; state.roles ??= new Set(); state.profiles ??= new Set(); state.groups ??= {}; state.instances ??= {}; state.images ??= []; state.launched ??= 0;
  const run = async (args: string[]): Promise<State> => {
    calls.push(args);
    const [service, action] = args;
    const flag = (name: string) => { const index = args.indexOf(name); return index === -1 ? '' : args[index + 1] ?? ''; };
    if (service === 'sts') return { Account: '123456789012' };
    // The default VPC always exists; the dedicated one only after it has been created.
    if (service === 'ec2' && action === 'describe-vpcs') return { Vpcs: flag('--filters').includes('is-default') ? [{ VpcId: 'vpc-default' }] : state.vpc ? [{ VpcId: 'vpc-own' }] : [] };
    if (service === 'ec2' && action === 'create-vpc') { state.vpc = { tags: flag('--tag-specifications') }; return { Vpc: { VpcId: 'vpc-own' } }; }
    if (service === 'ec2' && action === 'describe-subnets') return { Subnets: args.includes('Name=vpc-id,Values=vpc-default') ? [{ SubnetId: 'subnet-default', VpcId: 'vpc-default' }] : state.subnet ? [{ SubnetId: 'subnet-own', VpcId: 'vpc-own' }] : [] };
    if (service === 'ec2' && action === 'create-subnet') { state.subnet = { zone: flag('--availability-zone') || null }; return { Subnet: { SubnetId: 'subnet-own' } }; }
    if (service === 'ec2' && action === 'describe-volumes') return { Volumes: [{ AvailabilityZone: 'eu-central-1b' }] };
    if (service === 'ec2' && action === 'describe-internet-gateways') return { InternetGateways: state.gateway ? [{ InternetGatewayId: 'igw-1', Attachments: state.gateway.attached ? [{ VpcId: 'vpc-own' }] : [] }] : [] };
    if (service === 'ec2' && action === 'create-internet-gateway') { state.gateway = { attached: false }; return { InternetGateway: { InternetGatewayId: 'igw-1' } }; }
    if (service === 'ec2' && action === 'attach-internet-gateway') { if (state.failAttach) { state.failAttach = false; throw new Error('RequestLimitExceeded'); } state.gateway.attached = true; return {}; }
    if (service === 'ec2' && action === 'detach-internet-gateway') { state.gateway.attached = false; return {}; }
    if (service === 'ec2' && action === 'delete-internet-gateway') { state.gateway = null; return {}; }
    if (service === 'ec2' && action === 'describe-route-tables') return { RouteTables: [{ RouteTableId: 'rtb-1', Routes: state.route ? [{ DestinationCidrBlock: '0.0.0.0/0' }] : [] }] };
    if (service === 'ec2' && action === 'create-route') { state.route = true; return {}; }
    if (service === 'ec2' && action === 'delete-subnet') { state.subnet = null; return {}; }
    if (service === 'ec2' && action === 'delete-vpc') { state.vpc = null; state.route = false; return {}; }
    if (service === 'ssm' && action === 'get-parameter') {
      const name = flag('--name');
      if (name.startsWith('/aws/service/')) return { Parameter: { Value: 'ami-base' } };
      if (!(name in state.parameters)) throw notFound('ParameterNotFound');
      return { Parameter: { Value: state.parameters[name] } };
    }
    if (service === 'ssm' && action === 'describe-instance-information') return { InstanceInformationList: [{ PingStatus: 'Online' }] };
    if (service === 'ssm' && action === 'put-parameter') { state.parameters[flag('--name')] = flag('--value'); return {}; }
    if (service === 'ssm' && action === 'delete-parameter') { delete state.parameters[flag('--name')]; return {}; }
    if (service === 'iam') {
      const name = flag('--role-name') || flag('--instance-profile-name');
      if (action === 'get-role') { if (!state.roles.has(name)) throw notFound('NoSuchEntity'); return { Role: state.roleDetails?.[name] ?? {} }; }
      if (action === 'create-role') { if (state.requireBoundary && !args.includes('--permissions-boundary')) throw new Error('AccessDenied: not authorized to perform iam:CreateRole'); state.roles.add(name); (state.roleDetails ??= {})[name] = args.includes('--permissions-boundary') ? { PermissionsBoundary: { PermissionsBoundaryArn: flag('--permissions-boundary') } } : {}; return {}; }
      if (action === 'list-attached-role-policies') return { AttachedPolicies: state.legacyPolicy?.has(name) ? [{ PolicyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore' }] : [] };
      if (action === 'detach-role-policy') { state.legacyPolicy?.delete(name); return {}; }
      if (action === 'get-instance-profile') { if (!state.profiles.has(name)) throw notFound('NoSuchEntity'); return {}; }
      if (action === 'create-instance-profile') { state.profiles.add(name); return {}; }
      return {};
    }
    if (service === 'ec2' && action === 'describe-security-groups') { const name = /Values=(.*)/.exec(flag('--filters'))?.[1] ?? ''; return { SecurityGroups: state.groups[name] ? [{ GroupId: state.groups[name] }] : [] }; }
    if (service === 'ec2' && action === 'create-security-group') { state.groups[flag('--group-name')] = 'sg-1'; return { GroupId: 'sg-1' }; }
    if (service === 'ec2' && action === 'revoke-security-group-egress') { state.egressRevoked = true; return {}; }
    if (service === 'ec2' && action === 'authorize-security-group-egress') { const rule = JSON.parse(flag('--ip-permissions'))[0]; const key = JSON.stringify(rule); if ((state.egress ??= []).some((item: unknown) => JSON.stringify(item) === key)) throw new Error('InvalidPermission.Duplicate'); state.egress.push(rule); return {}; }
    if (service === 'ec2' && action === 'authorize-security-group-ingress') { const key = `${flag('--port')} ${flag('--cidr') || 'group'}`; if (state.authorized?.has(key)) throw new Error('Duplicate rule'); (state.authorized ??= new Set()).add(key); return {}; }
    if (service === 'ec2' && action === 'run-instances') {
      const id = `i-${++state.launched}`;
      state.instances[id] = { InstanceId: id, State: { Name: 'running' }, PublicIpAddress: '203.0.113.7', PrivateIpAddress: '10.0.0.7', BlockDeviceMappings: [{ DeviceName: '/dev/xvdf', Ebs: { VolumeId: 'vol-data' } }], userData: flag('--user-data'), tags: flag('--tag-specifications') };
      return { Instances: [{ InstanceId: id }] };
    }
    if (service === 'ec2' && action === 'describe-instances') {
      const ids = flag('--instance-ids'); if (ids && !state.instances[ids]) throw notFound('InvalidInstanceID.NotFound');
      return { Reservations: [{ Instances: ids ? [state.instances[ids]] : Object.values(state.instances) }] };
    }
    if (service === 'ec2' && action === 'wait') return {};
    if (service === 'ec2' && action === 'create-image') { const id = `ami-${state.images.length + 1}`; state.images.push({ ImageId: id, CreationDate: String(state.images.length), BlockDeviceMappings: [{ Ebs: { SnapshotId: `snap-${id}` } }] }); return { ImageId: id }; }
    if (service === 'ec2' && action === 'describe-images') return { Images: [...state.images] };
    if (service === 'ec2' && action === 'deregister-image') { state.images = state.images.filter((image: State) => image.ImageId !== flag('--image-id')); return {}; }
    if (service === 'ec2' && action === 'terminate-instances') { for (const id of args.slice(args.indexOf('--instance-ids') + 1).filter(a => a.startsWith('i-'))) delete state.instances[id]; return {}; }
    return {};
  };
  return { run, calls, state };
}
