#!/usr/bin/env node
/**
 * Detached entry point for `shepaw-hub restart`.
 *
 * Spawned by `spawnRestartOrchestrator` (restart.ts) so the orchestrator
 * survives the triggering process being killed (the agent running inside an
 * instance, or the dashboard itself). Waits a short grace so the triggering
 * HTTP response / CLI output is already flushed, acquires the restart lock,
 * runs the full restart sequence, then releases the lock. Progress goes to
 * `restart.log` via stdout/stderr.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import {
  acquireRestartLock,
  releaseRestartLock,
  runRestartOrchestrator,
  type RestartPlan,
} from './restart.js';

function parseFlags(argv: string[]): RestartPlan {
  const plan: RestartPlan = {};
  for (const arg of argv) {
    switch (arg) {
      case '--skip-dashboard':
        plan.dashboard = false;
        break;
      case '--no-instances':
        plan.instances = false;
        break;
      case '--no-peer':
        plan.peer = false;
        break;
      case '--no-gateway':
        plan.gateway = false;
        break;
      case '--upgrade':
        plan.upgrade = true;
        break;
      default:
        console.error(`[restart-daemon] Ignoring unknown flag: ${arg}`);
    }
  }
  return plan;
}

async function main(): Promise<void> {
  const plan = parseFlags(process.argv.slice(2));

  // Give the triggering process a beat to flush its HTTP response / CLI output
  // before we tear the dashboard down.
  await sleep(1_000);

  // Authoritative lock — rejects when another live restart is in progress.
  acquireRestartLock(plan);
  try {
    const report = await runRestartOrchestrator(plan);
    console.log(
      `[restart-daemon] Done: ${report.failed ? 'FAILED' : 'ok'} — ` +
        report.phases.map((ph) => `${ph.phase}:${ph.status}`).join(', '),
    );
    process.exitCode = report.failed ? 1 : 0;
  } finally {
    releaseRestartLock();
  }
}

main().catch((err) => {
  console.error(
    `[restart-daemon] Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
