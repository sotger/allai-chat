import type { Preferences, ThemePreference } from './types';

export const THEME_VALUES: ThemePreference[] = ['system', 'light', 'dark'];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEME_VALUES.includes(value as ThemePreference);
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
    reuseGoogleSignIn: raw?.reuseGoogleSignIn !== false
  };
}
