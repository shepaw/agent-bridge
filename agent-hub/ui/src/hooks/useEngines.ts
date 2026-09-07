import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { EngineInfo } from '../api/types.js';

/**
 * Engine catalog (GET /api/engines). `engines` stays `null` until the first
 * successful load so callers can distinguish "still loading / failed" from a
 * genuinely empty catalog. `reload` keeps the previous value and only refetches.
 *
 * Loading is two-phase: the catalog is fetched without the server-side CLI
 * scan (`?probe=0`) so saved instances render immediately, then a scanned
 * request fills in per-engine availability. `scanning` is true until that
 * second response lands (or fails).
 */
export function useEngines() {
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setScanning(true);
      const { engines: catalog } = await api.engines.list({ probe: false });
      setEngines(catalog);
      setLoading(false);
      const { engines: probed } = await api.engines.list();
      setEngines(probed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { engines, loading, scanning, error, reload: load };
}
