import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { app, dialog, shell } from 'electron';
import updater from 'electron-updater';

const { autoUpdater } = updater;

const RELEASES_URL = 'https://github.com/sotger/allai-chat/releases/latest';

let initialized = false;
let manualCheck = false;
let signedCache: boolean | undefined;

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
      ? 'This macOS build is not signed with an Apple Developer ID, so macOS cannot install updates automatically. Download the latest release instead.'
      : 'Updates are only available in packaged builds.'
  });
  if (response === 0) void shell.openExternal(RELEASES_URL);
}

export function checkForUpdates(manual: boolean): void {
  if (!canAutoUpdate()) {
    if (manual) void showReleaseFallback();
    return;
  }

  manualCheck = manual;
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
    if (!manualCheck) return;
    void dialog.showMessageBox({
      type: 'info',
      message: `ALLAI-CHAT ${info.version} is available.`,
      detail: 'It is being downloaded in the background.'
    });
  });

  autoUpdater.on('update-not-available', () => {
    if (manualCheck) {
      void dialog.showMessageBox({
        type: 'info',
        message: 'You are up to date.',
        detail: `ALLAI-CHAT ${app.getVersion()} is the latest version.`
      });
    }
    manualCheck = false;
  });

  autoUpdater.on('update-downloaded', (info) => {
    manualCheck = false;
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
  }
}
