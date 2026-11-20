import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, constants as fsConstants, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { app, BrowserWindow, dialog, net, shell } from 'electron';
import updater from 'electron-updater';

import { IPC_CHANNELS, type UpdateStatus } from '@shared/ipc';
import { isNewerVersion } from '@shared/version';

const { autoUpdater } = updater;

const REPO = 'sotger/allai-chat';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  /** "sha256:<hex>" when GitHub provides it (newer releases do). */
  digest?: string;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  name?: string;
  assets: ReleaseAsset[];
}

let initialized = false;
let manualCheck = false;
let signedCache: boolean | undefined;
let skippedVersion: string | undefined;
let macChecking = false;
let macDownloading = false;
/** Version announced by electron-updater, used for progress toasts. */
let pendingVersion = '';

// ── Shared helpers ───────────────────────────────────────────────────

function sendUpdateStatus(status: UpdateStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.updateStatus, status);
  }
}

function isDeveloperIdSigned(): boolean {
  if (process.platform !== 'darwin') return true;
  if (signedCache !== undefined) return signedCache;

  try {
    const bundlePath = path.resolve(app.getAppPath(), '../../..');
    const result = spawnSync('codesign', ['-dv', '--verbose=4', bundlePath], { encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    signedCache = /Authority=Developer ID Application/.test(output);
  } catch {
    signedCache = false;
  }
  return signedCache;
}

function canAutoUpdate(): boolean {
  if (!app.isPackaged) return false;
  if (process.env.ALLAI_DISABLE_AUTO_UPDATE === '1') return false;
  // Squirrel.Mac refuses to install updates for ad-hoc signed builds.
  if (process.platform === 'darwin' && !isDeveloperIdSigned()) return false;
  // Only AppImage builds can self-update on Linux.
  if (process.platform === 'linux' && !process.env.APPIMAGE) return false;
  return true;
}

async function showReleaseFallback(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Open Releases', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Automatic updates are not available in this build.',
    detail: process.platform === 'darwin'
      ? 'Updates are only available in the packaged app. Download the latest release instead.'
      : 'Updates are only available in packaged builds.'
  });
  if (response === 0) void shell.openExternal(RELEASES_URL);
}

function statePath(): string {
  return path.join(app.getPath('userData'), 'updates.json');
}

function readSkippedVersion(): string {
  if (skippedVersion !== undefined) return skippedVersion;
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf-8')) as { skippedVersion?: string };
    skippedVersion = typeof parsed.skippedVersion === 'string' ? parsed.skippedVersion : '';
  } catch {
    skippedVersion = '';
  }
  return skippedVersion;
}

async function writeSkippedVersion(version: string): Promise<void> {
  skippedVersion = version;
  try {
    await fs.writeFile(statePath(), JSON.stringify({ skippedVersion: version }), 'utf-8');
  } catch { /* non-fatal */ }
}

function macArch(): 'arm64' | 'x64' {
  if (process.arch === 'arm64') return 'arm64';
  const translated = (app as unknown as { runningUnderARM64Translation?: boolean })
    .runningUnderARM64Translation;
  return translated ? 'arm64' : 'x64';
}

function pickMacAsset(release: GithubRelease): ReleaseAsset | undefined {
  const arch = macArch();
  const zips = release.assets.filter((asset) => /\.zip$/i.test(asset.name));
  const exactZip = zips.find((asset) => asset.name.includes(arch));
  if (exactZip) return exactZip;
  if (zips.length === 1) return zips[0];

  // No per-arch zip: a DMG can still be downloaded and opened in Finder.
  const dmgs = release.assets.filter((asset) => /\.dmg$/i.test(asset.name));
  return dmgs.find((asset) => asset.name.includes(arch)) ?? (dmgs.length === 1 ? dmgs[0] : undefined);
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  const response = await net.fetch(RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `ALLAI-CHAT/${app.getVersion()}`
    }
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
  const parsed = await response.json() as GithubRelease;
  if (!parsed?.tag_name) throw new Error('The GitHub release has no tag.');
  return parsed;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// ── macOS fallback updater (ad-hoc signed builds) ────────────────────
// Squirrel.Mac refuses to install an update when the bundle is not signed with
// a Developer ID. The fallback talks to the GitHub API directly, downloads the
// matching zip and replaces the .app bundle after the process exits.

async function checkMacUpdate(manual: boolean): Promise<void> {
  if (macChecking || macDownloading) return;
  macChecking = true;
  // An automatic check stays quiet on network errors; a check the user asked
  // for (or a download they approved) always reports what happened.
  let announce = manual;
  sendUpdateStatus({ state: 'checking' });

  try {
    const release = await fetchLatestRelease();
    const version = release.tag_name.replace(/^v/i, '');
    if (!isNewerVersion(version, app.getVersion())) {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          message: 'You are up to date.',
          detail: `ALLAI-CHAT ${app.getVersion()} is the latest version.`
        });
      }
      sendUpdateStatus({ state: 'none', version: app.getVersion() });
      return;
    }

    // A background check asks once per version; "Later" is remembered.
    if (!manual && readSkippedVersion() === version) {
      sendUpdateStatus({ state: 'none', version: app.getVersion() });
      return;
    }

    sendUpdateStatus({ state: 'available', version });
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Download and Install', 'Release Notes', 'Later'],
      defaultId: 0,
      cancelId: 2,
      message: `ALLAI-CHAT ${version} is available.`,
      detail: `You have ${app.getVersion()}. The update is downloaded from GitHub and installed `
        + 'in place; the app restarts when it is ready.'
    });

    if (response === 1) {
      void shell.openExternal(release.html_url || RELEASES_URL);
      return;
    }
    if (response === 2) {
      await writeSkippedVersion(version);
      return;
    }

    announce = true;
    await downloadAndInstallMac(release, version);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (announce) {
      sendUpdateStatus({ state: 'error', message });
      const { response } = await dialog.showMessageBox({
        type: 'error',
        message: 'The update could not be completed.',
        detail: message,
        buttons: ['Open Releases', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      });
      if (response === 0) void shell.openExternal(RELEASES_URL);
    }
  } finally {
    macChecking = false;
  }
}

async function downloadAndInstallMac(release: GithubRelease, version: string): Promise<void> {
  const asset = pickMacAsset(release);
  if (!asset) throw new Error(`No macOS build for ${macArch()} was found in this release.`);

  macDownloading = true;
  sendUpdateStatus({ state: 'downloading', version, percent: 0 });

  try {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'allai-update-'));
    const target = path.join(directory, asset.name);
    await downloadFile(asset, target, version);

    if (asset.digest?.startsWith('sha256:')) {
      const expected = asset.digest.slice('sha256:'.length).toLowerCase();
      const actual = await sha256(target);
      if (actual !== expected) throw new Error('The downloaded file failed its checksum.');
    }

    sendUpdateStatus({ state: 'downloaded', version });

    if (!/\.zip$/i.test(asset.name)) {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        message: `ALLAI-CHAT ${version} was downloaded.`,
        detail: 'Open the downloaded disk image and replace the app in Applications.',
        buttons: ['Show in Finder', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      });
      if (response === 0) shell.showItemInFolder(target);
      return;
    }

    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart and Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `ALLAI-CHAT ${version} is ready to install.`,
      detail: 'The app will quit, replace the copy in Applications and start again.'
    });
    if (response !== 0) return;

    await installMacZip(target, version);
  } finally {
    macDownloading = false;
  }
}

async function downloadFile(asset: ReleaseAsset, target: string, version: string): Promise<void> {
  const response = await net.fetch(asset.browser_download_url, {
    headers: { 'User-Agent': `ALLAI-CHAT/${app.getVersion()}` }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const total = Number(response.headers.get('content-length') ?? asset.size ?? 0);
  const reader = response.body.getReader();
  const stream = createWriteStream(target);
  let received = 0;
  let lastPercent = -1;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (!stream.write(Buffer.from(value))) await once(stream, 'drain');

      const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
      if (percent !== lastPercent && (percent === 100 || percent - lastPercent >= 5)) {
        lastPercent = percent;
        sendUpdateStatus({ state: 'downloading', version, percent });
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }

  if (total > 0 && received < total) {
    throw new Error('The download was incomplete. Try again.');
  }
}

async function installMacZip(zipPath: string, version: string): Promise<void> {
  const bundlePath = path.resolve(app.getAppPath(), '../../..');
  if (!bundlePath.endsWith('.app')) {
    throw new Error('Could not locate the application bundle. Open the release page instead.');
  }

  const parent = path.dirname(bundlePath);
  if (bundlePath.includes('AppTranslocation')) {
    throw new Error('The app is running from a read-only location. Move ALLAI-CHAT to '
      + '/Applications and try again, or install the update from the release page.');
  }
  try {
    await fs.access(parent, fsConstants.W_OK);
  } catch {
    throw new Error(`The folder ${parent} is not writable. Move the app to Applications `
      + 'or install the update from the release page.');
  }

  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'allai-extract-'));
  const unzip = spawnSync('ditto', ['-x', '-k', zipPath, extractDir], { encoding: 'utf8' });
  if (unzip.status !== 0) {
    throw new Error(`Could not unzip the update: ${unzip.stderr || 'ditto failed'}`);
  }

  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (!appEntry) throw new Error('The update archive does not contain an app bundle.');
  const newApp = path.join(extractDir, appEntry.name);

  const scriptPath = path.join(os.tmpdir(), `allai-install-${Date.now()}.sh`);
  const script = `#!/bin/bash
set -u
pid="$1"
target="$2"
source="$3"
cleanup="$4"

# Wait for the running app to release the bundle.
for _ in $(seq 1 240); do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.5
done
sleep 1

new="\${target}.allai-new"
old="\${target}.allai-old"
rm -rf "$new" "$old"
if ! ditto "$source" "$new"; then exit 1; fi
xattr -dr com.apple.quarantine "$new" 2>/dev/null || true

if ! mv "$target" "$old"; then rm -rf "$new"; exit 1; fi
if ! mv "$new" "$target"; then mv "$old" "$target"; exit 1; fi
rm -rf "$old"
rm -rf "$cleanup"
open "$target"
rm -f "$0"
`;
  await fs.writeFile(scriptPath, script, 'utf-8');
  await fs.chmod(scriptPath, 0o755);

  const child = spawn('/bin/bash', [scriptPath, String(process.pid), bundlePath, newApp, extractDir], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  // Squirrel/electron-updater is not involved here; quit so the script can
  // replace the bundle.
  app.quit();
}

// ── Entry points ─────────────────────────────────────────────────────

export function checkForUpdates(manual: boolean): void {
  manualCheck = manual;

  if (process.platform === 'darwin' && !isDeveloperIdSigned()) {
    if (!app.isPackaged) {
      if (manual) void showReleaseFallback();
      return;
    }
    void checkMacUpdate(manual);
    return;
  }

  if (!canAutoUpdate()) {
    if (manual) void showReleaseFallback();
    return;
  }

  autoUpdater.checkForUpdates().catch((error: unknown) => {
    if (manual) {
      void dialog.showMessageBox({
        type: 'error',
        message: 'Could not check for updates.',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
    manualCheck = false;
  });
}

export function initAutoUpdater(): void {
  if (initialized) return;
  initialized = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version;
    sendUpdateStatus({ state: 'available', version: info.version });
    if (!manualCheck) return;
    void dialog.showMessageBox({
      type: 'info',
      message: `ALLAI-CHAT ${info.version} is available.`,
      detail: 'It is being downloaded in the background.'
    });
  });

  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus({ state: 'none', version: app.getVersion() });
    if (manualCheck) {
      void dialog.showMessageBox({
        type: 'info',
        message: 'You are up to date.',
        detail: `ALLAI-CHAT ${app.getVersion()} is the latest version.`
      });
    }
    manualCheck = false;
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus({
      state: 'downloading',
      version: pendingVersion || undefined,
      percent: Math.round(progress.percent)
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    manualCheck = false;
    sendUpdateStatus({ state: 'downloaded', version: info.version });
    void dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart and Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `ALLAI-CHAT ${info.version} is ready to install.`,
      detail: 'Restart the app to apply the update.'
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (error) => {
    if (manualCheck) {
      sendUpdateStatus({
        state: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
      void dialog.showMessageBox({
        type: 'error',
        message: 'Update check failed.',
        detail: error instanceof Error ? error.message : String(error)
      });
    }
    manualCheck = false;
  });

  if (canAutoUpdate()) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => undefined), 15_000);
  } else if (process.platform === 'darwin'
    && app.isPackaged
    && process.env.ALLAI_DISABLE_AUTO_UPDATE !== '1') {
    setTimeout(() => { void checkMacUpdate(false); }, 15_000);
  }
}
