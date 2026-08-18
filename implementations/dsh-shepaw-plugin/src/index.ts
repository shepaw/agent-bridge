/**
 * Shepaw bridge as a DeepSeek Harness (DSH) cordis plugin.
 *
 * Install into a DSH profile and boot it; the plugin mounts a Shepaw ACP v2.1
 * server and routes each Shepaw chat into a DSH Agent. See `../cordis.patch.yml`
 * for the composition entry and `../README.md` for install steps.
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import { DshShepawBridge } from './bridge.js';
import { resolveShepawBridgeConfig } from './config.js';
import type { ShepawBridgeConfig } from './config.js';

/** Stable cordis plugin name (referenced by `provide`/`inject` and patches). */
export const name = 'shepaw-bridge';

/** Core services required before the bridge mounts. */
export const inject = ['agents', 'sessions'];

export function apply(ctx: Context, config?: ShepawBridgeConfig): void {
  const resolved = resolveShepawBridgeConfig(config);
  const bridge = new DshShepawBridge(ctx, resolved);

  // Route DSH approval questions to the Shepaw UI (waterfall answerer).
  const offApproval = ctx.on(
    'approval/request',
    (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) =>
      bridge.decideApproval(req, next),
  );

  // Start the Shepaw WS server. `run()` resolves after listen and keeps the
  // server alive on the event loop; it does not block the DSH process.
  void bridge.run({ host: resolved.host, port: resolved.port });

  // Tear down in order when this plugin fiber is disposed.
  ctx.effect(() => {
    return async () => {
      offApproval();
      await bridge.close();
    };
  });
}

export { DshShepawBridge } from './bridge.js';
export { resolveShepawBridgeConfig } from './config.js';
export type { ShepawBridgeConfig, ResolvedShepawBridgeConfig } from './config.js';
