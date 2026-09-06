import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { EngineInfo } from '../api/types.js';

/**
 * Engine catalog (GET /api/engines). `engines` stays `null` until the first
 * successful load so callers can distinguish "still loading / failed" from a
 * genuinely empty catalog. `reload` keeps the previous value and only refetches.
 */
export function useEngines() {
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const { engines: list } = await api.engines.list();
      setEngines(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { engines, loading, error, reload: load };
}
