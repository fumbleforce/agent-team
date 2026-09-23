import { startControlPlane } from '../shared/controlPlane.ts';

// On Fly the control plane is one Machine. With a Sprites token it starts a worker on a project's Sprite when work waits; Sprites reach
// it at its public address, since they are not on the app's private network.
const publicUrl = `https://${process.env.FLY_APP_NAME ?? 'your-app'}.fly.dev`;
await startControlPlane({ publicUrl, internalUrl: publicUrl, launcher: process.env.SPRITE_TOKEN ? { ...(process.env.AGENT_TEAM_TOOLKIT_REF ? { toolkitRef: process.env.AGENT_TEAM_TOOLKIT_REF } : {}) } : null });
