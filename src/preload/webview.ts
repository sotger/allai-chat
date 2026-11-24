import { ipcRenderer, webFrame } from 'electron';

import { buildFingerprintScript } from './fingerprint';

const chromeVersion = process.versions.chrome || '138.0.0.0';
const chromeMajor = chromeVersion.split('.')[0] || chromeVersion;
const chromeUserAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

// Keep in sync with the client-hint headers set in src/main/index.ts.
const greaseBrand = 'Not)A;Brand';
const brands = [
  { brand: greaseBrand, version: '8' },
  { brand: 'Chromium', version: chromeMajor },
  { brand: 'Google Chrome', version: chromeMajor }
];

const fullVersionList = [
  { brand: greaseBrand, version: '8.0.0.0' },
  { brand: 'Chromium', version: chromeVersion },
  { brand: 'Google Chrome', version: chromeVersion }
];

const fingerprintScript = buildFingerprintScript({
  userAgent: chromeUserAgent,
  version: chromeVersion,
  major: chromeMajor,
  brands,
  fullVersionList,
  platform: process.platform
});

// The fingerprint script runs in the page's main world, which cannot reach
// Electron APIs. It flags a blocked passkey request with a DOM attribute; this
// isolated world watches for it and tells the app to hand the sign-in off to a
// real browser.
const passkeyGuard = new MutationObserver(() => {
  const root = document.documentElement;
  if (!root || root.getAttribute('data-allai-passkey-blocked') !== '1') return;
  root.removeAttribute('data-allai-passkey-blocked');
  ipcRenderer.sendToHost('allai:passkey-blocked');
});
passkeyGuard.observe(document, {
  attributes: true,
  subtree: true,
  attributeFilter: ['data-allai-passkey-blocked']
});

// Runs in the page's main world, before page scripts, even with contextIsolation.
webFrame.executeJavaScript(fingerprintScript).catch((err) => {
  console.error('[ALLAI-CHAT] Failed to apply guest fingerprint patches:', err);
});
