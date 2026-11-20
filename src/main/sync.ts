import { app } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { historyId } from '@shared/history';
import {
  describeSyncMerge,
  isSyncFileName,
  parseSyncFile,
  syncFileName,
  toSyncEntry,
  type HistorySyncFile,
  type SyncEntry,
  type SyncMergeResult
} from '@shared/sync';
import type { ServiceTab } from '@shared/types';
import type { DetectedSyncFolder, SyncStatus } from '@shared/sync';

import type { HistoryStore } from './history/store';

export type { DetectedSyncFolder, SyncStatus } from '@shared/sync';

/**
 * Cloud sync without OAuth, SDKs or a backend: the app writes one portable JSON
 * file per device into a folder the user already syncs (iCloud Drive, Google
 * Drive, OneDrive, Dropbox, Nextcloud, a network share). The cloud client does
 * the transport, so the feature works the same on macOS, Windows and Linux.
 */
export class HistorySync {
  private deviceId = '';
  private deviceName = '';
  private running = false;
  private queued = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private lastSignature = '';
  private status: SyncStatus = {
    enabled: false,
    folder: '',
    deviceId: '',
    deviceName: '',
    files: 0
  };

  constructor(
    private readonly deps: {
      store: HistoryStore;
      getTabs: () => ServiceTab[];
      getFolder: () => string;
      isEnabled: () => boolean;
      onStatus: (status: SyncStatus) => void;
      onIndexChanged: () => void;
    }
  ) {}

  /** Reads (or creates) the per-device identity used in the file name. */
  init(): void {
    const file = path.join(app.getPath('userData'), 'history', 'device.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { id?: string; name?: string };
      this.deviceId = typeof parsed.id === 'string' && parsed.id ? parsed.id : '';
      this.deviceName = typeof parsed.name === 'string' && parsed.name ? parsed.name : '';
    } catch { /* first launch */ }

    if (!this.deviceId) {
      this.deviceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this.deviceName = os.hostname().replace(/\.local$/i, '') || 'This Mac';
    }
    if (!this.deviceName) this.deviceName = os.hostname();

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ id: this.deviceId, name: this.deviceName }), 'utf-8');
    } catch { /* non-fatal */ }

    this.status = {
      ...this.status,
      deviceId: this.deviceId,
      deviceName: this.deviceName
    };
  }

  getStatus(): SyncStatus {
    return {
      ...this.status,
      enabled: this.deps.isEnabled(),
      folder: this.deps.getFolder()
    };
  }

  /** Starts the periodic pass. Files change when the cloud client downloads. */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.syncNow();
    }, 10 * 60 * 1000);
    setTimeout(() => { void this.syncNow(); }, 20_000);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /** Called after every local capture; a cloud folder does not need instant writes. */
  schedule(delayMs = 120_000): void {
    if (!this.deps.isEnabled() || !this.deps.getFolder()) return;
    if (this.running) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.syncNow();
    }, delayMs);
  }

  /**
   * Writes this device's snapshot, then merges every other device's file into
   * the local index. Runs are serialized; a request during a run is coalesced.
   */
  async syncNow(): Promise<SyncStatus> {
    const folder = this.deps.getFolder();
    if (!this.deviceId) this.init();
    if (!this.deps.isEnabled() || !folder) {
      this.publish();
      return this.getStatus();
    }

    if (this.running) {
      this.queued = true;
      return this.getStatus();
    }
    this.running = true;

    try {
      await this.deps.store.load();
      await this.writeSnapshot(folder);

      const merge: SyncMergeResult = {
        imported: 0, upgraded: 0, tombstoned: 0, noTab: 0, unchanged: 0
      };
      let files = 1;
      let names: string[] = [];
      try {
        names = (await fsp.readdir(folder)).filter(isSyncFileName).sort();
      } catch (error) {
        throw new Error(`Cannot read the sync folder: ${messageOf(error)}`);
      }

      const ownName = syncFileName(this.deviceId);
      for (const name of names) {
        if (name === ownName) continue;
        files += 1;
        let file: HistorySyncFile | undefined;
        try {
          file = parseSyncFile(await fsp.readFile(path.join(folder, name), 'utf-8'));
        } catch { /* a cloud placeholder or a partially uploaded file */ }
        if (!file) continue;
        if (file.deviceId === this.deviceId) continue;
        await this.mergeFile(file, merge);
      }

      // Another device may have added rows that we now want in our own file.
      const changed = merge.imported > 0 || merge.upgraded > 0 || merge.tombstoned > 0;
      if (changed) await this.writeSnapshot(folder, true);
      if (changed) this.deps.onIndexChanged();

      this.status = {
        ...this.status,
        enabled: true,
        folder,
        files: Math.max(files, 1),
        lastSyncAt: Date.now(),
        lastError: undefined,
        lastMerge: merge,
        summary: describeSyncMerge(merge)
      };
      this.publish();
      return this.getStatus();
    } catch (error) {
      this.status = {
        ...this.status,
        enabled: true,
        folder,
        lastSyncAt: Date.now(),
        lastError: messageOf(error)
      };
      this.publish();
      return this.getStatus();
    } finally {
      this.running = false;
      if (this.queued) {
        this.queued = false;
        this.schedule(2000);
      }
    }
  }

  private async mergeFile(file: HistorySyncFile, merge: SyncMergeResult): Promise<void> {
    if (file.clearedAt > 0) {
      merge.tombstoned += await this.deps.store.applyRemoteClear(file.clearedAt);
    }
    if (file.tombstones.length > 0) {
      merge.tombstoned += await this.deps.store.applyRemoteTombstones(file.tombstones);
    }

    for (const entry of file.entries) {
      if (this.deps.store.isTombstoned(entry.providerId, entry.url, entry.capturedAt)) {
        // Already deleted here (or by a global clear). Not a change: the row
        // stays out of the index, but the status line should not report the
        // same deletion on every sync.
        continue;
      }
      const tab = this.resolveTab(entry);
      if (!tab) {
        merge.noTab += 1;
        continue;
      }

      const id = historyId(tab.id, entry.url);
      const previous = this.deps.store.get(id);
      if (previous
        && previous.text === entry.text
        && previous.title === entry.title
        && previous.titleOnly === entry.titleOnly) {
        merge.unchanged += 1;
        continue;
      }

      const merged = this.deps.store.upsert({
        id,
        tabId: tab.id,
        providerId: tab.providerId,
        service: tab.label,
        url: entry.url,
        title: entry.title,
        text: entry.text,
        capturedAt: entry.capturedAt,
        titleOnly: entry.titleOnly
      });

      const changed = !previous
        || merged.text !== previous.text
        || merged.title !== previous.title
        || merged.titleOnly !== previous.titleOnly;
      if (!previous) merge.imported += 1;
      else if (changed) merge.upgraded += 1;
      else merge.unchanged += 1;
    }
  }

  /**
   * A tab id is machine-local. Match by provider, then by label, then by host.
   * When several tabs of one provider could match, skip the row instead of
   * mixing two accounts.
   */
  private resolveTab(entry: SyncEntry): ServiceTab | undefined {
    const candidates = this.deps.getTabs().filter((tab) => tab.providerId === entry.providerId);
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];

    const label = entry.service.trim().toLowerCase();
    const byLabel = candidates.filter((tab) => tab.label.trim().toLowerCase() === label);
    if (byLabel.length === 1) return byLabel[0];
    if (byLabel.length > 1) return undefined;

    let host = '';
    try { host = new URL(entry.url).hostname.toLowerCase(); } catch { return undefined; }
    const byHost = candidates.filter((tab) => {
      try { return new URL(tab.url).hostname.toLowerCase() === host; } catch { return false; }
    });
    return byHost.length === 1 ? byHost[0] : undefined;
  }

  private signature(): string {
    const entries = this.deps.store.all();
    let capturedAt = 0;
    for (const entry of entries) capturedAt = Math.max(capturedAt, entry.capturedAt);
    const tombstones = this.deps.store.tombstonesForSync();
    let deletedAt = 0;
    for (const item of tombstones) deletedAt = Math.max(deletedAt, item.deletedAt);
    return `${entries.length}:${capturedAt}:${tombstones.length}:${deletedAt}:${this.deps.store.getClearedAt()}`;
  }

  private async writeSnapshot(folder: string, force = false): Promise<void> {
    const signature = this.signature();
    if (!force && signature === this.lastSignature) return;

    const file: HistorySyncFile = {
      format: 'allai-history',
      version: 1,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      appVersion: app.getVersion(),
      exportedAt: Date.now(),
      entries: this.deps.store.all().map(toSyncEntry),
      tombstones: this.deps.store.tombstonesForSync(),
      clearedAt: this.deps.store.getClearedAt()
    };

    await fsp.mkdir(folder, { recursive: true });
    const target = path.join(folder, syncFileName(this.deviceId));
    const temp = `${target}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(file), 'utf-8');
    await fsp.rename(temp, target);
    this.lastSignature = signature;
  }

  /** Manual "Export…": one self-contained file the user can move anywhere. */
  async exportTo(target: string): Promise<HistorySyncFile> {
    await this.deps.store.load();
    const file: HistorySyncFile = {
      format: 'allai-history',
      version: 1,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      appVersion: app.getVersion(),
      exportedAt: Date.now(),
      entries: this.deps.store.all().map(toSyncEntry),
      tombstones: this.deps.store.tombstonesForSync(),
      clearedAt: this.deps.store.getClearedAt()
    };
    await fsp.writeFile(target, JSON.stringify(file), 'utf-8');
    return file;
  }

  /** Manual "Import…": merges a file without enabling folder sync. */
  async importFrom(source: string): Promise<SyncMergeResult> {
    await this.deps.store.load();
    const raw = await fsp.readFile(source, 'utf-8');
    const file = parseSyncFile(raw);
    if (!file) throw new Error('This file is not an ALLAI-CHAT history export.');
    const merge: SyncMergeResult = {
      imported: 0, upgraded: 0, tombstoned: 0, noTab: 0, unchanged: 0
    };
    await this.mergeFile(file, merge);
    this.deps.onIndexChanged();
    return merge;
  }

  private publish(): void {
    this.deps.onStatus(this.getStatus());
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Folders that are usually synced by an OS-level cloud client. The app never
 * talks to iCloud/Google/Microsoft APIs: writing into these directories is the
 * whole integration.
 */
export function detectSyncFolders(platform = process.platform, home = os.homedir()): DetectedSyncFolder[] {
  const roots: Array<{ dir: string; label: string }> = [];

  if (platform === 'darwin') {
    roots.push(
      { dir: path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), label: 'iCloud Drive' },
      { dir: path.join(home, 'Library', 'CloudStorage', 'iCloudDrive'), label: 'iCloud Drive' },
      { dir: path.join(home, 'Dropbox'), label: 'Dropbox' },
      { dir: path.join(home, 'Google Drive'), label: 'Google Drive' }
    );
    // Google Drive, OneDrive and Dropbox for macOS mount under CloudStorage.
    // Keep the account name: several Google accounts are common, and two
    // identical "Google Drive" buttons are impossible to tell apart.
    const cloudStorage = path.join(home, 'Library', 'CloudStorage');
    try {
      for (const entry of fs.readdirSync(cloudStorage)) {
        const dir = path.join(cloudStorage, entry);
        if (entry.startsWith('GoogleDrive-')) {
          const account = entry.slice('GoogleDrive-'.length);
          roots.push({
            dir: path.join(dir, 'My Drive'),
            label: account ? `Google Drive (${account})` : 'Google Drive'
          });
        } else if (entry.startsWith('OneDrive')) {
          const suffix = entry.slice('OneDrive'.length);
          roots.push({ dir, label: suffix ? `OneDrive${suffix}` : 'OneDrive' });
        } else if (entry.startsWith('Dropbox')) {
          const suffix = entry.slice('Dropbox'.length);
          roots.push({ dir, label: suffix ? `Dropbox${suffix}` : 'Dropbox' });
        }
      }
    } catch { /* no CloudStorage folder */ }
  } else if (platform === 'win32') {
    const profile = process.env.USERPROFILE || home;
    roots.push(
      { dir: path.join(profile, 'iCloudDrive'), label: 'iCloud Drive' },
      { dir: path.join(profile, 'Google Drive'), label: 'Google Drive' },
      { dir: path.join(profile, 'OneDrive'), label: 'OneDrive' },
      { dir: path.join(profile, 'Dropbox'), label: 'Dropbox' }
    );
    if (process.env.OneDrive) roots.push({ dir: process.env.OneDrive, label: 'OneDrive' });
  } else {
    roots.push(
      { dir: path.join(home, 'Nextcloud'), label: 'Nextcloud' },
      { dir: path.join(home, 'Dropbox'), label: 'Dropbox' },
      { dir: path.join(home, 'Google Drive'), label: 'Google Drive' },
      { dir: path.join(home, 'Yandex.Disk'), label: 'Yandex Disk' }
    );
  }

  const seen = new Set<string>();
  const found: DetectedSyncFolder[] = [];
  for (const root of roots) {
    if (!root.dir || seen.has(root.dir)) continue;
    try {
      if (!fs.statSync(root.dir).isDirectory()) continue;
    } catch { continue; }
    seen.add(root.dir);
    // Keep the cloud root clean: the app owns a single subfolder.
    found.push({ path: path.join(root.dir, 'ALLAI-CHAT'), label: root.label });
  }

  // Two providers can still produce the same label (for example two OneDrive
  // mounts without a personal suffix). Make every button unique.
  const used = new Set<string>();
  return found.map((folder) => {
    let label = folder.label;
    let suffix = 2;
    while (used.has(label)) {
      label = `${folder.label} (${suffix})`;
      suffix += 1;
    }
    used.add(label);
    return { ...folder, label };
  });
}
