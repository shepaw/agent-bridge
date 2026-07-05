import type { Instance, InstanceStatus } from '../api/types.js';

export type BusyFilter = 'all' | 'idle' | 'busy' | 'overloaded' | 'unknown';

/** Subsequence fuzzy match on instance label (case-insensitive). */
export function matchInstanceLabel(instance: Instance, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const label = instance.label.toLowerCase();
  let i = 0;
  for (const ch of q) {
    i = label.indexOf(ch, i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
}

export function matchBusyFilter(status: InstanceStatus, filter: BusyFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unknown') {
    return status.busyLevel === null || status.availability !== 'online';
  }
  return status.availability === 'online' && status.busyLevel === filter;
}

export function filterInstances(
  instances: Instance[],
  opts: { search: string; busy: BusyFilter; engine: string },
): Instance[] {
  return instances.filter((p) => {
    if (!matchInstanceLabel(p, opts.search)) return false;
    if (!matchBusyFilter(p.status, opts.busy)) return false;
    if (opts.engine !== 'all' && p.engine !== opts.engine) return false;
    return true;
  });
}

export function uniqueEngines(instances: Instance[]): string[] {
  return [...new Set(instances.map((p) => p.engine))].sort();
}
