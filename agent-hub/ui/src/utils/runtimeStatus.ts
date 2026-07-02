import type { InstanceStatus } from '../api/types.js';

const AVAILABILITY_LABELS: Record<InstanceStatus['availability'], string> = {
  offline: '离线',
  starting: '启动中',
  online: '在线',
  degraded: '异常',
};

const BUSY_LABELS: Record<NonNullable<InstanceStatus['busyLevel']>, string> = {
  idle: '空闲',
  busy: '繁忙',
  overloaded: '高负载',
};

export function availabilityLabel(status: InstanceStatus): string {
  return AVAILABILITY_LABELS[status.availability];
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
  return BUSY_LABELS[status.busyLevel];
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
  if (status.running && status.pid !== null) parts.push(`PID ${status.pid}`);
  if (status.probeError) parts.push(status.probeError);
  return parts.join(' · ');
}
