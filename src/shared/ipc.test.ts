import { describe, expect, it } from 'vitest';

import { IPC_CHANNELS } from './ipc';

describe('IPC channels', () => {
  it('uses the allai: prefix', () => {
    for (const value of Object.values(IPC_CHANNELS)) {
      expect(value).toMatch(/^allai:/);
    }
  });

  it('has no duplicate channel names', () => {
    const values = Object.values(IPC_CHANNELS);
    expect(new Set(values).size).toBe(values.length);
  });
});
