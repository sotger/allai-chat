import { app, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { normalizePreferences } from '@shared/preferences';
import type { Preferences } from '@shared/types';

let current: Preferences | undefined;

function preferencesPath(): string {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function applyTheme(preferences: Preferences): void {
  nativeTheme.themeSource = preferences.theme;
}

export function loadPreferences(): Preferences {
  let stored: Partial<Preferences> | undefined;
  try {
    stored = JSON.parse(fs.readFileSync(preferencesPath(), 'utf-8')) as Partial<Preferences>;
  } catch { /* first launch or unreadable file */ }

  current = normalizePreferences(stored, app.getPath('downloads'));
  applyTheme(current);
  return current;
}

export function getPreferences(): Preferences {
  if (!current) return loadPreferences();
  return current;
}

export function savePreferences(patch: Partial<Preferences>): Preferences {
  const next = normalizePreferences({ ...getPreferences(), ...patch }, app.getPath('downloads'));
  current = next;
  applyTheme(next);
  try {
    fs.writeFileSync(preferencesPath(), JSON.stringify(next, null, 2), 'utf-8');
  } catch { /* non-fatal */ }
  return next;
}

export function isDarkTheme(): boolean {
  return nativeTheme.shouldUseDarkColors;
}
