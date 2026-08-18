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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
  { dir: 'implementations/dsh-shepaw-plugin', name: 'shepaw-dsh-plugin' },
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

function getNpmAuthToken() {
  const fromEnv = process.env.NPM_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const rc = readFileSync(join(homedir(), '.npmrc'), 'utf8');
    const match = rc.match(/^\/\/registry\.npmjs\.org\/:_authToken=(.+)$/m);
    if (match) return match[1].trim();
  } catch {
    // ignore
  }
  try {
    const token = runCapture('npm config get //registry.npmjs.org/:_authToken');
    if (token && token !== 'undefined' && token !== 'null') return token;
  } catch {
    // npm may block reading protected _authToken
  }
  return '';
}

function hasGranularPublishToken() {
  const token = process.env.NPM_TOKEN?.trim() || getNpmAuthToken();
  return token.startsWith('npm_');
}

function usesBypassPublishToken() {
  return hasGranularPublishToken();
}

function printGranularTokenSetup() {
  const user = runCapture('npm whoami');
  console.error(`
✗ Cannot publish with \`npm login\` session token + OTP on npm 11 (auth-and-writes).
  OTP works for \`npm profile get\` but registry rejects publish — this is an npm limitation.

Create a Granular Access Token (one-time setup, ~2 minutes):

  1. Open https://www.npmjs.com/settings/${user}/tokens
  2. Generate New Token → Granular Access Token
  3. Permissions: Read and Write
  4. Bypass 2FA: enabled
  5. Packages & scopes: All packages (or @shepaw/* + unscoped)
  6. Expiration: 7 days (recommended for first publish)

  7. Copy the npm_... token, then run:

     npm config set //registry.npmjs.org/:_authToken npm_PASTE_TOKEN_HERE
     make publish

  Revoke the token on npmjs.com after publishing if you prefer.
`);
}

function requireGranularPublishToken() {
  if (hasGranularPublishToken()) {
    ok('Granular publish token configured (npm_...)');
    return;
  }
  if (!isTwoFactorEnabled()) return;
  printGranularTokenSetup();
  process.exit(1);
}

function checkPublishAuthMode() {
  if (hasGranularPublishToken()) {
    ok('Granular publish token (npm_...) — publish without OTP');
    return;
  }
  if (isTwoFactorEnabled()) {
    console.warn('⚠ No granular token — only npm login session in ~/.npmrc');
    console.warn('  Publish with OTP will fail on npm 11. Run: make publish-auth');
  } else {
    checkTwoFactor();
  }
}

function cmdPublishAuth() {
  checkNpmAuth();
  printGranularTokenSetup();
  process.exit(0);
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
      ok('npm 2FA enabled (publish needs --otp; make publish will prompt)');
      console.warn(
        '  Session login often fails publish+OTP. Prefer a granular token:',
      );
      console.warn('  https://www.npmjs.com/settings/~tokens → Generate New Token');
      console.warn('  Permissions: Read and Write, Bypass 2FA → npm config set //registry.npmjs.org/:_authToken npm_...');
    }
  } catch {
    console.warn('⚠ Could not read npm profile (skipping 2FA check).');
  }
}

function isTwoFactorEnabled() {
  try {
    const profile = runCapture('npm profile get');
    return !profile.includes('two-factor auth: disabled');
  } catch {
    return true;
  }
}

async function promptLine(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

function publishPackage(cwd, accessFlag, otp) {
  const otpFlag = otp ? ` --otp=${otp}` : '';
  const env = { ...process.env };
  if (otp) env.npm_config_otp = otp;

  // Pack then publish the .tgz — NOT `npm publish .`
  // In a monorepo, `publish .` uses execWorkspaces and the session token often
  // ignores --otp on the first registry PUT (npm 11). Tarball publish avoids that.
  const tarball = runCapture('npm pack --ignore-scripts', { cwd });
  if (!tarball.endsWith('.tgz')) {
    fail(`npm pack did not return a tarball name in ${cwd}`);
  }
  const tgzPath = join(cwd, tarball);
  try {
    run(`npm publish ${tarball}${accessFlag}${otpFlag}`, { cwd, env });
  } finally {
    if (existsSync(tgzPath)) unlinkSync(tgzPath);
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
  checkPublishAuthMode();
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
  console.log('\n✓ Dry-run complete. Run: make publish-auth then make publish');
}

async function cmdPublish() {
  const version = checkVersions();
  requireGranularPublishToken();

  if (process.env.CONFIRM !== '1') {
    const answer = await promptLine(
      `Publish ${PACKAGES.length} packages at v${version} to the public npm registry? [y/N] `,
    );
    if (answer.toLowerCase() !== 'y') {
      console.log('Aborted.');
      process.exit(1);
    }
  }

  console.log('\n── publishing (granular token, no OTP) ──\n');
  for (const { dir, name } of PACKAGES) {
    console.log(`\n▸ ${name}@${version}`);
    const cwd = join(ROOT, dir);
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    const accessFlag = pkg.name.startsWith('@') ? ' --access public' : '';
    publishPackage(cwd, accessFlag, '');
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
  case 'publish-auth':
    cmdPublishAuth();
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
    console.log(`Usage: node scripts/npm-release.mjs <check|dry-run|publish|publish-auth|version>`);
    process.exit(command ? 1 : 0);
}
