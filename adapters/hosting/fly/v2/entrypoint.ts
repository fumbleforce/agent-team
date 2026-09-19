import { startControlPlane } from '../../shared/controlPlane.ts';

await startControlPlane({ publicUrl: `https://${process.env.FLY_APP_NAME ?? 'your-app'}.fly.dev` });
