#!/usr/bin/env node
// Builds the macOS app and installs it into /Applications, replacing the
// previous build. User data (logins, tabs, window state) lives in
// ~/Library/Application Support/ALLAI-CHAT and is preserved.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const appName = pkg.build?.productName ?? 'ALLAI-CHAT';
const target = `/Applications/${appName}.app`;
const openAfterInstall = !process.argv.includes('--no-open');

function step(message) {
  console.log(`\n\u25B6 ${message}`);
}

function fail(message) {
  console.error(`\n\u2716 ${message}`);
  process.exit(1);
}

if (process.platform !== 'darwin') {
  fail('This script installs the macOS build and can only run on macOS.');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) fail(`Command failed: ${command} ${args.join(' ')}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRunning() {
  const result = spawnSync('pgrep', ['-f', `${appName}.app/Contents/MacOS/${appName}`], { stdio: 'ignore' });
  return result.status === 0;
}

step('Generating app icon');
run(process.execPath, ['scripts/generate-icon.mjs']);

step('Building renderer, preload and main process');
run(process.execPath, [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build']);

step('Packaging macOS app');
run(process.execPath, [join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--dir', '--mac']);

// electron-builder writes either dist-electron/mac/... or dist-electron/mac-<arch>/...
const distDir = join(root, 'dist-electron');
if (!existsSync(distDir)) fail('Build output not found in dist-electron');
const candidates = readdirSync(distDir)
  .filter((entry) => entry.startsWith('mac'))
  .map((entry) => join(distDir, entry, `${appName}.app`))
  .filter((path) => existsSync(path) && statSync(path).isDirectory());

if (candidates.length === 0) fail(`Packaged ${appName}.app not found in dist-electron`);

const builtApp = candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

step(`Closing running ${appName}`);
if (isRunning()) {
  spawnSync('osascript', ['-e', `tell application "${appName}" to quit`], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 20 && isRunning(); attempt++) sleep(250);
  if (isRunning()) spawnSync('pkill', ['-f', `${appName}.app/Contents/MacOS/${appName}`], { stdio: 'ignore' });
  sleep(500);
}

if (!existsSync('/Applications')) fail('No /Applications directory found.');
try {
  accessSync('/Applications', constants.W_OK);
} catch {
  fail('/Applications is not writable. Run with sudo: sudo npm run install:mac');
}

step(`Installing to ${target}`);
if (existsSync(target)) rmSync(target, { recursive: true, force: true });
const copy = spawnSync('ditto', [builtApp, target], { stdio: 'inherit' });
if (copy.status !== 0) fail(`Could not copy the app to ${target}`);

console.log(`\n\u2714 ${appName} ${pkg.version} installed to ${target}`);
console.log(`  User data kept in ~/Library/Application Support/${appName}`);

if (openAfterInstall) {
  spawnSync('open', ['-a', target], { stdio: 'ignore' });
  console.log(`  Launched ${appName}`);
}
