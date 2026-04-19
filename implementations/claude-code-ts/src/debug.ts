import createDebug from 'debug';
import type { WebSocket } from 'ws';

const wire = createDebug('shepaw:wire');
const gateway = createDebug('shepaw:gateway');

function truncate(text: string, max = 600): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (${text.length - max} more chars)`;
}

/** Wrap a WebSocket so every outgoing and incoming JSON-RPC frame is logged under DEBUG=shepaw:wire. */
export function wrapForDebug(ws: WebSocket): void {
  if (!wire.enabled) return;
  const origSend = ws.send.bind(ws);
  ws.send = function patchedSend(data: unknown, cbOrOpts?: unknown, maybeCb?: unknown): void {
    const text = typeof data === 'string' ? data : String(data);
    wire('→ %s', truncate(text));
    // Preserve the original ws.send overloads.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return origSend(data as any, cbOrOpts as any, maybeCb as any);
  } as unknown as WebSocket['send'];

  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf-8');
    wire('← %s', truncate(text));
  });
}

export const log = {
  gateway,
  wire,
};
