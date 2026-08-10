/**
 * `shepaw-hub quickstart` — interactive onboarding that collapses
 * init → engine pick → instance add → start → pair into one flow.
 *
 * Non-interactive / scripted use:
 *   shepaw-hub quickstart --engine claude-code --cwd ~/code --yes
 *
 * Defaults favor same-Wi-Fi pairing: bind host `0.0.0.0`, QR URL derived
 * from the machine's LAN address (via createHubPairing / resolvePublicHost).
 */

import { basename, resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import qrcode from 'qrcode-terminal';
import {
  addInstance,
  allocateInstanceId,
  createHubPairing,
  ensureInstanceDir,
  isEngineDisabled,
  isKnownEngine,
  listEngineInfos,
  loadOrCreateHubConfig,
  nextFreePort,
  resolveEngineAvailability,
  resolvePublicHost,
  startInstance,
  type HubConfig,
} from '@shepaw/agent-hub-core';

export interface QuickstartOptions {
  engine?: string;
  cwd?: string;
  label?: string;
  host?: string;
  /** Skip interactive prompts when flags supply everything needed. */
  yes?: boolean;
  /** Suppress the terminal QR (still prints the short code + URL). */
  noQr?: boolean;
}

interface EngineChoice {
  id: string;
  displayName: string;
  available: boolean;
  reason: string | null;
}

function probeEngines(cfg: HubConfig): EngineChoice[] {
  const infos = listEngineInfos(cfg.customEngines);
  return infos.map((info) => {
    const disabled = isEngineDisabled(cfg, info.id);
    const avail = resolveEngineAvailability(info.id, {
      disabled,
      customCommand: info.builtin ? undefined : info.acpCommand,
      skipVersion: true,
      skipRemoteAuthProbe: true,
    });
    return {
      id: info.id,
      displayName: info.displayName,
      available: avail.available,
      reason: avail.unavailableReason,
    };
  });
}

async function ask(rl: ReturnType<typeof createInterface>, prompt: string, fallback: string): Promise<string> {
  const raw = (await rl.question(`${prompt} [${fallback}]: `)).trim();
  return raw.length > 0 ? raw : fallback;
}

function printEngineMenu(engines: EngineChoice[]): void {
  console.log('\nAvailable engines:');
  engines.forEach((e, i) => {
    const mark = e.available ? '✓' : '✗';
    const note = e.available ? '' : `  (${e.reason ?? 'not available'})`;
    console.log(`  ${String(i + 1).padStart(2)}) ${e.id.padEnd(14)} ${mark} ${e.displayName}${note}`);
  });
}

function pickDefaultEngine(engines: EngineChoice[], preferred?: string): string {
  if (preferred && engines.some((e) => e.id === preferred && e.available)) return preferred;
  const firstOk = engines.find((e) => e.available);
  if (firstOk) return firstOk.id;
  // Fall back to preferred / first even if unavailable — start will surface the real error.
  return preferred ?? engines[0]?.id ?? 'claude-code';
}

async function resolveEngineInteractive(
  rl: ReturnType<typeof createInterface> | undefined,
  engines: EngineChoice[],
  opts: QuickstartOptions,
): Promise<string> {
  if (opts.engine) {
    if (!engines.some((e) => e.id === opts.engine)) {
      throw new Error(
        `Unknown engine "${opts.engine}". Run \`shepaw-hub engine list\` for options.`,
      );
    }
    return opts.engine;
  }
  if (!rl) {
    throw new Error('Pass --engine <id> when running non-interactively (no TTY).');
  }

  printEngineMenu(engines);
  const fallback = pickDefaultEngine(engines);
  const answer = await ask(rl, 'Pick an engine (number or id)', fallback);
  const asIndex = Number(answer);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= engines.length) {
    return engines[asIndex - 1]!.id;
  }
  return answer;
}

export async function runQuickstart(opts: QuickstartOptions = {}): Promise<void> {
  const interactive = process.stdin.isTTY === true && opts.yes !== true;
  const rl = interactive ? createInterface({ input, output }) : undefined;

  try {
    console.log('shepaw-hub quickstart');
    console.log('─────────────────────');

    // 1. Init hub config (idempotent).
    const cfg = loadOrCreateHubConfig();
    console.log(`\nHub: ${cfg.path}`);

    // 2. Probe engines.
    const engines = probeEngines(cfg);
    const available = engines.filter((e) => e.available);
    if (available.length === 0) {
      console.log('\nNo engine CLIs detected on PATH.');
      console.log('Install one (e.g. Claude Code / Codex / Cursor) and re-run, or pass --engine anyway.');
      printEngineMenu(engines);
    }

    // 3. Engine.
    const engine = await resolveEngineInteractive(rl, engines, opts);
    if (!isKnownEngine(engine, cfg.customEngines)) {
      throw new Error(`Unknown engine "${engine}". Run \`shepaw-hub engine list\`.`);
    }
    const chosen = engines.find((e) => e.id === engine);
    if (chosen && !chosen.available) {
      console.log(`\n⚠ Engine "${engine}" is not ready: ${chosen.reason ?? 'unavailable'}`);
      console.log('  Continuing anyway — `start` will fail with a clearer error if the CLI is missing.');
    }

    // 4. Working directory.
    let cwd = opts.cwd ? resolvePath(opts.cwd) : process.cwd();
    if (rl && opts.cwd === undefined) {
      cwd = resolvePath(await ask(rl, 'Working directory', cwd));
    }
    if (!existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    // 5. Label.
    const defaultLabel = basename(cwd) || 'my-agent';
    let label = opts.label ?? defaultLabel;
    if (rl && opts.label === undefined) {
      label = await ask(rl, 'Display label', defaultLabel);
    }

    // 6. Bind host — LAN by default so the phone can reach the gateway.
    const host = opts.host ?? '0.0.0.0';
    const publicHost = resolvePublicHost(host);

    // Confirm before mutating when interactive.
    console.log('\nAbout to:');
    console.log(`  engine:  ${engine}`);
    console.log(`  cwd:     ${cwd}`);
    console.log(`  label:   ${label}`);
    console.log(`  bind:    ${host} (next free port from 8090; phone sees ${publicHost})`);
    if (rl) {
      const go = (await ask(rl, 'Create instance, start it, and print a pairing QR? (Y/n)', 'Y')).toLowerCase();
      if (go === 'n' || go === 'no') {
        console.log('Aborted.');
        return;
      }
    }

    // 7. Register.
    const fresh = loadOrCreateHubConfig();
    const id = allocateInstanceId(fresh.instances.map((p) => p.id));
    const port = await nextFreePort({ reserved: fresh.instances.map((p) => p.port) });
    addInstance(fresh, {
      id,
      label,
      engine,
      cwd,
      port,
      host,
      baseUrl: '',
      extraArgs: [],
      createdAt: new Date().toISOString(),
    });
    ensureInstanceDir(id);
    const registered = loadOrCreateHubConfig().instances.find((p) => p.id === id);
    if (registered === undefined) {
      throw new Error(`Internal error: instance "${id}" missing after registration.`);
    }
    console.log(`\nRegistered instance ${id}`);
    console.log(`  ${registered.label} · ${registered.engine} · ${registered.host}:${registered.port}`);

    // 8. Start.
    console.log('\nStarting gateway…');
    const started = await startInstance(registered);
    if (started.alreadyRunning) {
      console.log(`Already running (pid ${started.pid}).`);
    } else {
      console.log(`Started (pid ${started.pid}).`);
    }

    // 9. Pair — hub-wide so one scan authorizes this (and any future) agent.
    console.log('\nMinting pairing QR…');
    const pairing = createHubPairing({
      label: `quickstart:${label}`,
      bootstrapInstanceId: id,
    });

    console.log('');
    console.log('╭──────────────────────────────────────────────╮');
    console.log(`│  Pairing code:  ${pairing.display.padEnd(28, ' ')} │`);
    console.log('╰──────────────────────────────────────────────╯');
    console.log('');
    console.log(`  Valid until:  ${new Date(pairing.expiresAt).toLocaleString()}`);
    console.log(`  Pair URL:     ${pairing.pairUrl}`);
    console.log('');
    console.log('  In the Shepaw app: Add agent → scan the QR (or type the code).');
    console.log('  Keep this machine on the same Wi-Fi as your phone.');
    console.log('');

    if (opts.noQr !== true) {
      qrcode.generate(pairing.qrPayload, { small: true }, (qr: string) => {
        process.stdout.write(qr);
      });
      console.log('');
    }

    console.log('Useful next commands:');
    console.log(`  shepaw-hub status ${id}`);
    console.log(`  shepaw-hub logs ${id} -f`);
    console.log(`  shepaw-hub test ${id} --rpc     # verify HTTP + Noise`);
    console.log(`  shepaw-hub pair ${id}           # mint another code later`);
    console.log(`  shepaw-hub doctor               # diagnose setup issues`);
    console.log('');
  } finally {
    rl?.close();
  }
}
