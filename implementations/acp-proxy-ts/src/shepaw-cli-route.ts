/**
 * Where a Hub-side `shepaw` invocation should run.
 *
 * Store hits that belong to this Hub device stay local (existing /api/v1).
 * Everything else — including another device's pouch — is posted to the
 * paired App so its gate / she-only / allowlist decide.
 */

const STORE_URI = /^store:\/\/([^/]+)\/([a-f0-9]{16})(?:\/(.*))?$/i;

export function storeUriDevice(uri: string | undefined): string | undefined {
  const raw = (uri ?? '').trim();
  if (!raw) return undefined;
  const m = STORE_URI.exec(raw);
  return m?.[2]?.toLowerCase();
}

/** Hub-local when there is no foreign device in `--uri`. */
export function isHubLocalStoreCommand(opts: {
  flags: Record<string, string>;
  hubDeviceId: string;
}): boolean {
  const hub = opts.hubDeviceId.trim().toLowerCase();
  if (!hub) return true;
  const device = storeUriDevice(opts.flags.uri);
  if (!device) return true;
  return device === hub;
}

export function isSessionCreateCommand(
  namespace: string,
  subcommand: string,
): boolean {
  if (namespace !== 'chat') return false;
  return (
    subcommand === 'session.create' ||
    subcommand === 'group.session.create'
  );
}

/** Hub-native shims that must not be forwarded (group inbox / resume.md). */
export function isHubNativeCommand(
  namespace: string,
  subcommand: string,
): boolean {
  if (namespace === 'group') return true;
  if (namespace === 'context' && subcommand.startsWith('agents.resume-')) {
    return true;
  }
  return false;
}

const HUB_SHIM_STORE = new Set(['read', 'write', 'list', 'meta']);

/** Store commands the Hub shim can run against this device's pouch. */
export function keepStoreOnHub(opts: {
  subcommand: string;
  flags: Record<string, string>;
  hubDeviceId: string;
}): boolean {
  if (!HUB_SHIM_STORE.has(opts.subcommand)) return false;
  return isHubLocalStoreCommand({
    flags: opts.flags,
    hubDeviceId: opts.hubDeviceId,
  });
}

/** True when the PATH shim should POST to the paired App. */
export function shouldForwardToApp(opts: {
  namespace: string | undefined;
  subcommand: string;
  flags: Record<string, string>;
  hubDeviceId: string;
  hubForwardEnabled: boolean;
}): boolean {
  if (!opts.hubForwardEnabled) return false;
  const ns = opts.namespace;
  if (!ns) return false;
  if (isHubNativeCommand(ns, opts.subcommand)) return false;
  if (ns === 'store' && keepStoreOnHub(opts)) return false;
  return true;
}

export function joinSubcommand(positional: string[]): {
  namespace: string | undefined;
  subcommand: string;
} {
  const namespace = positional[0];
  return {
    namespace,
    subcommand: positional.slice(1).join('.'),
  };
}
