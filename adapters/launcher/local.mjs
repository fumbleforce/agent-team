// A persistent worker process polls the queue and claims jobs itself: starting is a no-op and
// the handle only records that nothing was started.
export const NAME = 'local';

export function create() {
  return {
    kind: NAME,
    async start(job) { return { kind: NAME, jobId: job.id, startedAt: Date.now() }; },
    async stop() { return { stopped: false }; },
    async status() { return { state: 'external' }; },
  };
}
