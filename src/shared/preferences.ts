import type { Preferences, ThemePreference } from './types';

export const THEME_VALUES: ThemePreference[] = ['system', 'light', 'dark'];

/** Interface font sizes offered in Settings, in px. */
export const UI_FONT_SIZES = [13, 14, 15, 16] as const;

export const DEFAULT_UI_FONT_SIZE = 13;

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEME_VALUES.includes(value as ThemePreference);
}

export function isUiFontSize(value: unknown): value is number {
  return typeof value === 'number' && (UI_FONT_SIZES as readonly number[]).includes(value);
}

/**
 * Turns whatever was read from disk (or sent over IPC) into a valid
 * Preferences object. `fallbackDirectory` is the platform download folder.
 */
export function normalizePreferences(raw: Partial<Preferences> | undefined, fallbackDirectory: string): Preferences {
  const directory = typeof raw?.downloadDirectory === 'string' ? raw.downloadDirectory.trim() : '';
  return {
    theme: isThemePreference(raw?.theme) ? raw.theme : 'system',
    downloadDirectory: directory || fallbackDirectory,
    reuseGoogleSignIn: raw?.reuseGoogleSignIn !== false,
    uiFontSize: isUiFontSize(raw?.uiFontSize) ? raw.uiFontSize : DEFAULT_UI_FONT_SIZE,
    historyIndexEnabled: raw?.historyIndexEnabled !== false,
    historyBackfillEnabled: raw?.historyBackfillEnabled === true
  };
}
