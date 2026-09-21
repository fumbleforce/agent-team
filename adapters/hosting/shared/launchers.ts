import type { LauncherFactory } from '@agent-team/coordinator';
import { createLauncher } from '../../launcher/index.ts';

// How a deployment starts workers for queued work: its own settings (network, image, parameter prefix) merged with what each
// project's manifest says about publishing. The coordinator only decides that a worker is needed; this makes one.
export function launcherFactory(settings: Record<string, unknown>, coordinatorUrl: string | undefined): LauncherFactory {
  return (kind, project) => {
    const manifest = project.manifest as { scm?: { kind?: string }; delivery?: { repository?: string; baseBranch?: string; publishAuthorized?: boolean }; engine?: { default?: string } };
    const publish = manifest.scm?.kind && manifest.delivery?.repository ? { scm: manifest.scm.kind, repository: manifest.delivery.repository, base: manifest.delivery.baseBranch ?? 'main' } : null;
    const options = {
      ...settings,
      coordinatorUrl,
      sessions: 'packet',
      manifest: { publishAuthorized: manifest.delivery?.publishAuthorized === true },
      publish,
      ...(manifest.engine?.default ? { engine: manifest.engine.default } : {}),
    };
    return createLauncher(kind, options as Parameters<typeof createLauncher>[1]) as unknown as ReturnType<LauncherFactory>;
  };
}
