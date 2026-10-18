import { describe, expect, it } from 'vitest';

import { PROVIDER_CONFIGS, PROVIDER_LIST } from './providers';

describe('provider configs', () => {
  it('every provider has the required fields', () => {
    for (const config of Object.values(PROVIDER_CONFIGS)) {
      expect(config.id).toBeTruthy();
      expect(config.displayName).toBeTruthy();
      expect(config.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(config.icon).toBeTruthy();
    }
  });

  it('all known providers have an https url', () => {
    for (const id of PROVIDER_LIST) {
      if (id === 'custom') continue;
      expect(PROVIDER_CONFIGS[id].url).toMatch(/^https:\/\//);
    }
  });

  it('the provider list covers every configured provider', () => {
    expect(new Set(PROVIDER_LIST)).toEqual(new Set(Object.keys(PROVIDER_CONFIGS)));
  });

  it('provider ids are unique in the list', () => {
    expect(new Set(PROVIDER_LIST).size).toBe(PROVIDER_LIST.length);
  });
});
