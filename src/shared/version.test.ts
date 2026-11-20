import { describe, expect, it } from 'vitest';

import { compareVersions, isNewerVersion, parseVersion } from './version';

describe('version helpers', () => {
  it('parses plain, prefixed and prerelease versions', () => {
    expect(parseVersion('1.7.3')).toEqual({ major: 1, minor: 7, patch: 3, prerelease: [] });
    expect(parseVersion('v2.0')).toEqual({ major: 2, minor: 0, patch: 0, prerelease: [] });
    expect(parseVersion('1.8.0-beta.2')?.prerelease).toEqual(['beta', '2']);
    expect(parseVersion('nope')).toBeUndefined();
  });

  it('orders stable versions numerically', () => {
    expect(compareVersions('1.7.3', '1.7.2')).toBe(1);
    expect(compareVersions('1.7.3', '1.7.3')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
  });

  it('treats a release as newer than its prerelease', () => {
    expect(compareVersions('1.8.0', '1.8.0-beta.1')).toBe(1);
    expect(compareVersions('1.8.0-beta.2', '1.8.0-beta.1')).toBe(1);
    expect(compareVersions('1.8.0-beta.1', '1.8.0-alpha.9')).toBe(1);
  });

  it('ignores a leading v and build metadata', () => {
    expect(isNewerVersion('v1.8.0', '1.7.3')).toBe(true);
    expect(isNewerVersion('1.8.0+build.5', '1.8.0')).toBe(false);
    expect(isNewerVersion('1.7.3', '1.7.3')).toBe(false);
  });
});
