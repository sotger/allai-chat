import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { buildFingerprintScript } from './fingerprint';

const data = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0',
  version: '152.0.0.0',
  major: '152',
  brands: [],
  fullVersionList: [],
  platform: 'darwin'
};

interface Harness {
  credentials: { get: (options?: unknown) => Promise<unknown>; create: (options?: unknown) => Promise<unknown> };
  notices: Map<string, { textContent: string }>;
  /** Attributes the script set on <html>, e.g. the passkey handoff flag. */
  documentAttributes: Map<string, string>;
}

/**
 * Runs the generated fingerprint script inside a VM with just enough DOM and
 * WebAuthn surface to exercise the passkey guard.
 */
function runScript(platformAuthenticatorAvailable: boolean, platform = 'darwin'): Harness {
  const notices = new Map<string, { textContent: string }>();
  const documentAttributes = new Map<string, string>();
  const body = {
    appendChild: (element: { id: string; textContent: string }) => {
      notices.set(element.id, element);
    }
  };
  const document = {
    body,
    documentElement: {
      ...body,
      setAttribute: (name: string, value: string) => { documentAttributes.set(name, value); },
      removeAttribute: (name: string) => { documentAttributes.delete(name); },
      getAttribute: (name: string) => documentAttributes.get(name) ?? null
    },
    getElementById: (id: string) => notices.get(id) ?? null,
    createElement: () => {
      const element = {
        id: '',
        textContent: '',
        style: { cssText: '' },
        children: [] as unknown[],
        setAttribute: () => undefined,
        addEventListener: () => undefined,
        appendChild: () => undefined,
        remove: () => notices.delete(element.id)
      };
      return element;
    }
  };

  const credentials = {
    get: async () => ({ id: 'original' }),
    create: async () => ({ id: 'original' })
  };

  const window: Record<string, unknown> = {};
  const PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => platformAuthenticatorAvailable
  };
  window.PublicKeyCredential = PublicKeyCredential;

  const context = vm.createContext({
    window,
    navigator: { credentials, userAgent: '', userAgentData: {} },
    document,
    PublicKeyCredential,
    DOMException,
    console: { warn: () => undefined, error: () => undefined },
    performance: { now: () => 0, timeOrigin: 0 },
    setTimeout: () => 0,
    Notification: { permission: 'default' }
  });

  vm.runInContext(buildFingerprintScript({ ...data, platform }), context);
  return { credentials, notices, documentAttributes };
}

const publicKeyRequest = { publicKey: { challenge: new Uint8Array(16) } };

describe('guest WebAuthn guard', () => {
  it('rejects passkey requests and hands the sign-in to the app without a banner', async () => {
    const { credentials, notices, documentAttributes } = runScript(false);

    await expect(credentials.get(publicKeyRequest)).rejects.toMatchObject({ name: 'NotAllowedError' });
    await expect(credentials.create(publicKeyRequest)).rejects.toMatchObject({ name: 'NotAllowedError' });
    // macOS opens Safari itself, so the page stays clean.
    expect(notices.size).toBe(0);
    // The preload uses this attribute to tell the app to open Safari.
    expect(documentAttributes.get('data-allai-passkey-blocked')).toBe('1');
  });

  it('points at the cookie import on platforms without the Safari handoff', async () => {
    const { credentials, notices, documentAttributes } = runScript(false, 'win32');
    await expect(credentials.get(publicKeyRequest)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(notices.get('allai-passkey-notice')?.textContent).toContain('Import cookies');
    expect(documentAttributes.get('data-allai-passkey-blocked')).toBe('1');
  });

  it('leaves password and federated credential requests alone', async () => {
    const { credentials, notices } = runScript(false);

    await expect(credentials.get({ password: true })).resolves.toEqual({ id: 'original' });
    expect(notices.size).toBe(0);
  });

  it('stays quiet for conditional passkey autofill, which runs on page load', async () => {
    const { credentials, notices } = runScript(false);

    await expect(credentials.get({ ...publicKeyRequest, mediation: 'conditional' })).rejects.toMatchObject({
      name: 'NotAllowedError'
    });
    expect(notices.size).toBe(0);
  });

  it('passes requests through when a platform authenticator is available', async () => {
    const { credentials, notices } = runScript(true);

    await expect(credentials.get(publicKeyRequest)).resolves.toEqual({ id: 'original' });
    expect(notices.size).toBe(0);
  });
});
