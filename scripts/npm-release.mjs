#!/usr/bin/env node
/**
 * npm monorepo release helper for agent-bridge.
 *
 * Usage:
 *   node scripts/npm-release.mjs check
 *   node scripts/npm-release.mjs dry-run
 *   node scripts/npm-release.mjs publish
 *   node scripts/npm-release.mjs version 0.1.1
 */

import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Publish order: dependencies before dependents. */
const PACKAGES = [
  { dir: 'sdks/shepaw-acp-sdk-typescript', name: 'shepaw-acp-sdk' },
  { dir: 'implementations/acp-proxy-ts', name: 'shepaw-acp-proxy-gateway' },
  { dir: 'agent-hub/core', name: '@shepaw/agent-hub-core' },
  { dir: 'agent-hub/ui', name: '@shepaw/agent-hub-ui' },
  { dir: 'agent-hub/api', name: '@shepaw/agent-hub-api' },
  { dir: 'agent-hub/cli', name: 'shepaw-agent-hub' },
];

const INTERNAL_NAMES = new Set(PACKAGES.map((p) => p.name));

function readPkg(dir) {
  const path = join(ROOT, dir, 'package.json');
  return { path, data: JSON.parse(readFileSync(path, 'utf8')) };
}

function writePkg(pkg) {
  writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, 2)}\n`);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
}

function runCapture(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], ...opts }).trim();
}

function loadAll() {
  return PACKAGES.map((meta) => ({ meta, ...readPkg(meta.dir) }));
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

function checkNpmAuth() {
  try {
    const user = runCapture('npm whoami');
    ok(`npm logged in as ${user}`);
  } catch {
    fail('Not logged in to npm. Run: npm login');
  }

  try {
    const org = runCapture('npm org ls shepaw');
    if (!org.includes('owner') && !org.includes('developer') && !org.includes('admin')) {
      console.warn('⚠ Could not confirm @shepaw org membership (continuing).');
    } else {
      ok('@shepaw org membership confirmed');
    }
  } catch {
    console.warn('⚠ Could not list shepaw org members (continuing if you are the owner).');
  }
}

function checkTwoFactor() {
  try {
    const profile = runCapture('npm profile get');
    if (profile.includes('two-factor auth: disabled')) {
      console.warn(
        '⚠ npm 2FA is disabled. npm strongly recommends enabling it before publish.',
      );
      console.warn('  https://docs.npmjs.com/requiring-two-factor-authentication');
    } else {
      ok('npm 2FA enabled');
    }
  } catch {
    console.warn('⚠ Could not read npm profile (skipping 2FA check).');
  }
}

function checkVersions() {
  const pkgs = loadAll();
  const versions = pkgs.map((p) => p.data.version);
  const unique = [...new Set(versions)];
  if (unique.length !== 1) {
    fail(`Package versions differ: ${unique.join(', ')}. Run: make version VERSION=x.y.z`);
  }
  ok(`All packages at version ${unique[0]}`);
  return unique[0];
}

function checkInternalDeps() {
  for (const pkg of loadAll()) {
    const deps = { ...pkg.data.dependencies, ...pkg.data.optionalDependencies };
    for (const [name, range] of Object.entries(deps ?? {})) {
      if (!INTERNAL_NAMES.has(name)) continue;
      if (range === '*' || range.startsWith('workspace:')) {
        fail(`${pkg.meta.name}: internal dependency "${name}" uses "${range}" — use ^x.y.z`);
      }
    }
  }
  ok('Internal dependency ranges look publishable');
}

function checkGitClean() {
  try {
    const status = runCapture('git status --porcelain');
    if (status) {
      console.warn('⚠ Working tree is not clean (recommended to commit before publish):');
      console.warn(status.split('\n').map((l) => `    ${l}`).join('\n'));
    } else {
      ok('Git working tree clean');
    }
  } catch {
    console.warn('⚠ Not a git repo or git unavailable (skipping clean check).');
  }
}

function checkRegistryAvailability(version) {
  for (const { name } of PACKAGES) {
    try {
      const published = runCapture(`npm view ${name} version`);
      if (published === version) {
        fail(
          `${name}@${version} already exists on npm. Bump version: make version VERSION=x.y.z`,
        );
      }
      console.log(`  ${name}: latest on npm is ${published} (will publish ${version})`);
    } catch {
      console.log(`  ${name}: not yet on npm (first publish)`);
    }
  }
}

function cmdCheck() {
  console.log('── npm publish preflight ──\n');
  checkNpmAuth();
  checkTwoFactor();
  const version = checkVersions();
  checkInternalDeps();
  checkGitClean();
  console.log('\n── registry ──');
  checkRegistryAvailability(version);
  console.log('\n✓ Preflight passed. Run: make publish-dry-run');
}

function cmdDryRun() {
  console.log('── npm pack dry-run ──\n');
  for (const { dir, name } of PACKAGES) {
    console.log(`\n▸ ${name}`);
    run(`npm pack --dry-run`, { cwd: join(ROOT, dir) });
  }
  console.log('\n✓ Dry-run complete. Run: CONFIRM=1 make publish');
}

async function cmdPublish() {
  const version = checkVersions();
  if (process.env.CONFIRM !== '1') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `Publish ${PACKAGES.length} packages at v${version} to the public npm registry? [y/N] `,
    );
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(1);
    }
  }

  console.log('\n── publishing ──\n');
  for (const { dir, name } of PACKAGES) {
    console.log(`\n▸ ${name}@${version}`);
    const cwd = join(ROOT, dir);
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const accessFlag = pkg.name.startsWith('@') ? ' --access public' : '';
    run(`npm publish${accessFlag}`, { cwd });
    ok(`Published ${name}@${version}`);
  }

  console.log(`\n✓ All packages published at v${version}`);
  console.log(`  Tag release: git tag v${version} && git push origin v${version}`);
  console.log('  Verify: npm install -g shepaw-agent-hub');
}

function cmdVersion(nextVersion) {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(nextVersion)) {
    fail(`Invalid semver: ${nextVersion}`);
  }

  const range = `^${nextVersion}`;
  for (const pkg of loadAll()) {
    pkg.data.version = nextVersion;
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const deps = pkg.data[section];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        if (INTERNAL_NAMES.has(name)) deps[name] = range;
      }
    }
    writePkg(pkg);
    ok(`${pkg.meta.name} → ${nextVersion}`);
  }

  console.log('\nRun: npm install && make publish-check');
}

const [command, arg] = process.argv.slice(2);

switch (command) {
  case 'check':
    cmdCheck();
    break;
  case 'dry-run':
    cmdDryRun();
    break;
  case 'publish':
    cmdPublish().catch((err) => {
      console.error(err);
      process.exit(1);
    });
    break;
  case 'version':
    if (!arg) fail('Usage: node scripts/npm-release.mjs version <x.y.z>');
    cmdVersion(arg);
    break;
  default:
    console.log(`Usage: node scripts/npm-release.mjs <check|dry-run|publish|version>`);
    process.exit(command ? 1 : 0);
}
