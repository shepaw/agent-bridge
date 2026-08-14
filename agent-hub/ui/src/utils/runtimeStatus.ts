import type { InstanceStatus } from '../api/types.js';
import { t } from '../i18n/index.js';

const AVAILABILITY_KEYS: Record<InstanceStatus['availability'], 'status.offline' | 'status.starting' | 'status.online' | 'status.degraded'> = {
  offline: 'status.offline',
  starting: 'status.starting',
  online: 'status.online',
  degraded: 'status.degraded',
};

const BUSY_KEYS: Record<NonNullable<InstanceStatus['busyLevel']>, 'status.idle' | 'status.busy' | 'status.overloaded'> = {
  idle: 'status.idle',
  busy: 'status.busy',
  overloaded: 'status.overloaded',
};

export function availabilityLabel(status: InstanceStatus): string {
  return t(AVAILABILITY_KEYS[status.availability]);
}

export function availabilityColor(status: InstanceStatus): string {
  switch (status.availability) {
    case 'online':
      return '#a6e3a1';
    case 'starting':
      return '#f9e2af';
    case 'degraded':
      return '#fab387';
    default:
      return '#6c7086';
  }
}

export function busyLabel(status: InstanceStatus): string | null {
  if (status.busyLevel === null) return null;
  const label = t(BUSY_KEYS[status.busyLevel]);
  if (status.activeTasks !== null && status.activeTasks > 0) {
    return t('status.tasks', { label, count: status.activeTasks });
  }
  return label;
}

export function busyColor(status: InstanceStatus): string {
  switch (status.busyLevel) {
    case 'overloaded':
      return '#f38ba8';
    case 'busy':
      return '#fab387';
    case 'idle':
      return '#94e2d5';
    default:
      return '#6c7086';
  }
}

export function formatRuntimeSummary(status: InstanceStatus): string {
  const parts = [availabilityLabel(status)];
  const busy = busyLabel(status);
  if (busy !== null) parts.push(busy);
  if (status.running && status.pid !== null) parts.push(t('status.pid', { pid: status.pid }));
  if (status.probeError) parts.push(status.probeError);
  return parts.join(' · ');
}
