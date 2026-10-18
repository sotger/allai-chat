#!/usr/bin/env node
// Runs electron-builder with a clean environment.
//
// GitHub Actions evaluates missing secrets to empty strings, and electron-builder
// treats an empty CSC_LINK as "a certificate path was provided" and fails. This
// wrapper drops empty signing variables and Apple credentials on non-macOS jobs.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');

const env = { ...process.env };
const signingKeys = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
  'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE'
];

for (const key of signingKeys) {
  if (env[key] !== undefined && env[key].trim() === '') delete env[key];
}

// Apple credentials only make sense on macOS. Windows/Linux signing will use
// their own secrets if added later.
if (process.platform !== 'darwin') {
  delete env.CSC_LINK;
  delete env.CSC_KEY_PASSWORD;
  delete env.APPLE_ID;
  delete env.APPLE_APP_SPECIFIC_PASSWORD;
  delete env.APPLE_TEAM_ID;
  delete env.APPLE_API_KEY;
  delete env.APPLE_API_KEY_ID;
  delete env.APPLE_API_ISSUER;
  delete env.APPLE_KEYCHAIN;
  delete env.APPLE_KEYCHAIN_PROFILE;
}

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
