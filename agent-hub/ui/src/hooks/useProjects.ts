import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import type { Project } from '../api/types.js';

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const list = await api.projects.list();
      setProjects(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Poll every 3 s to pick up status changes from the CLI
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [load]);

  return { projects, loading, error, reload: load };
}

// ── Log streaming via WebSocket ────────────────────────────────────

export interface UseLogsOptions {
  tail?: number;
}

export function useLogs(projectId: string | null, opts: UseLogsOptions = {}) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!projectId) return;

    const tail = opts.tail ?? 100;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}/ws/logs/${projectId}?tail=${tail}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setLines([]);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; text?: string };
        if (msg.type === 'data' && msg.text) {
          setLines((prev) => {
            const newLines = msg.text!.split('\n');
            // Keep at most 2000 lines to avoid unbounded memory growth
            return [...prev, ...newLines].slice(-2000);
          });
        }
      } catch {
        // ignore parse errors
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
      setConnected(false);
    };
  }, [projectId, opts.tail]);

  const clear = useCallback(() => setLines([]), []);

  return { lines, connected, clear };
}
