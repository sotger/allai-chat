import { app, shell, type DownloadItem, type Session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuid } from 'uuid';

import type { DownloadRecord, DownloadState } from '@shared/ipc';

const MAX_RECORDS = 60;

function sanitizeFilename(raw: string): string {
  const base = path.basename(raw || 'download').replace(/[\u0000-\u001f]/g, '').trim();
  return base || 'download';
}

function uniqueSavePath(directory: string, filename: string): string {
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let candidate = path.join(directory, filename);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${stem} (${counter})${extension}`);
    counter += 1;
  }
  return candidate;
}

/**
 * Per-session download handling. Every service partition gets its own
 * `will-download` hook, so downloads started by any tab (or by its sign-in
 * popup) land in the configured folder.
 */
export class DownloadManager {
  private sessions = new WeakSet<Session>();
  private items = new Map<string, DownloadItem>();
  private records = new Map<string, DownloadRecord>();
  private lastProgressEmit = new Map<string, number>();

  constructor(
    private readonly getDirectory: () => string,
    private readonly emit: (downloads: DownloadRecord[]) => void
  ) {}

  attach(ses: Session): void {
    if (this.sessions.has(ses)) return;
    this.sessions.add(ses);
    ses.on('will-download', (_event, item) => this.start(item));
  }

  list(): DownloadRecord[] {
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  cancel(id: string): void {
    this.items.get(id)?.cancel();
  }

  showInFolder(id: string): void {
    const record = this.records.get(id);
    if (!record?.savePath) return;
    try { fs.accessSync(record.savePath); } catch { return; }
    shell.showItemInFolder(record.savePath);
  }

  async open(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record?.savePath) return;
    try { await shell.openPath(record.savePath); } catch { /* ignore */ }
  }

  private directory(): string {
    const configured = this.getDirectory();
    try {
      fs.mkdirSync(configured, { recursive: true });
      return configured;
    } catch {
      const fallback = app.getPath('downloads');
      try { fs.mkdirSync(fallback, { recursive: true }); } catch { /* ignore */ }
      return fallback;
    }
  }

  private start(item: DownloadItem): void {
    const id = uuid();
    const directory = this.directory();
    const filename = sanitizeFilename(item.getFilename());
    const savePath = uniqueSavePath(directory, filename);
    item.setSavePath(savePath);

    const record: DownloadRecord = {
      id,
      filename,
      url: item.getURL(),
      savePath,
      state: 'progressing',
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now()
    };

    this.items.set(id, item);
    this.records.set(id, record);
    this.trim();
    this.publish();

    item.on('updated', () => {
      const now = Date.now();
      const last = this.lastProgressEmit.get(id) ?? 0;
      if (now - last < 300) return;
      this.lastProgressEmit.set(id, now);
      this.update(id, item);
    });

    item.on('done', (_event, state) => {
      this.lastProgressEmit.delete(id);
      this.items.delete(id);
      const current = this.records.get(id);
      if (current) {
        current.state = state as DownloadState;
        current.receivedBytes = item.getReceivedBytes();
        current.totalBytes = item.getTotalBytes() || current.totalBytes;
      }
      this.publish();
    });
  }

  private update(id: string, item: DownloadItem): void {
    const record = this.records.get(id);
    if (!record || record.state !== 'progressing') return;
    record.state = item.getState() as DownloadState;
    record.receivedBytes = item.getReceivedBytes();
    record.totalBytes = item.getTotalBytes() || record.totalBytes;
    this.publish();
  }

  private trim(): void {
    if (this.records.size <= MAX_RECORDS) return;
    for (const [id, record] of this.records) {
      if (this.records.size <= MAX_RECORDS) break;
      if (record.state !== 'progressing') this.records.delete(id);
    }
  }

  private publish(): void {
    this.emit(this.list());
  }
}
