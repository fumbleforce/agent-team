import { useCallback, useEffect, useState } from 'react';
import { api, type ApiError } from './client';

export interface Resource<T> { data: T | null; error: ApiError | null; reload(): void; set(update: (current: T) => T): void }

// Snapshot half of snapshot-then-stream: load a view, let the caller patch or reload it from stream events.
export function useResource<T>(path: string | null): Resource<T> {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: ApiError | null }>({ path, data: null, error: null });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path).then(data => { if (live) setState({ path, data, error: null }); }, error => { if (live) setState({ path, data: null, error: error as ApiError }); });
    return () => { live = false; };
  }, [path, version]);
  const reload = useCallback(() => setVersion(value => value + 1), []);
  const set = useCallback((update: (current: T) => T) => setState(current => (current.data ? { ...current, data: update(current.data) } : current)), []);
  return { data: state.path === path ? state.data : null, error: state.path === path ? state.error : null, reload, set };
}
