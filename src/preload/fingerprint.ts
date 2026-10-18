/**
 * Fingerprint patches for guest webviews.
 *
 * These must run in the page's MAIN world: Google (and other sites) compare
 * `navigator.userAgentData` / `navigator.platform` with the User-Agent and
 * Client-Hints headers. A normal preload runs in Electron's isolated world, so
 * patching the isolated `navigator` has no effect on the page and Google shows
 * "This browser or app may not be secure". We therefore build a self-contained
 * script and evaluate it with `webFrame.executeJavaScript`, which runs in the
 * main world before any page script.
 */

export interface FingerprintData {
  userAgent: string;
  version: string;
  major: string;
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
}

export function buildFingerprintScript(data: FingerprintData): string {
  const payload = JSON.stringify(data);

  return `(() => {
  if (window.__allaiChatFingerprintApplied) return;
  window.__allaiChatFingerprintApplied = true;

  const D = ${payload};

  const defineGetter = (target, key, value) => {
    try {
      Object.defineProperty(target, key, { configurable: true, enumerable: true, get: () => value });
    } catch (err) { /* property is not configurable, ignore */ }
  };

  const buildArrayLike = (entries) => Object.assign(entries, {
    item: (index) => entries[index] || null,
    namedItem: (name) => entries.find((entry) => entry.name === name || entry.type === name) || null
  });

  const plugins = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', type: 'application/pdf' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', type: 'application/pdf' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', type: 'application/pdf' },
    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', type: 'application/pdf' },
    { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format', type: 'application/pdf' }
  ];

  const mimeTypes = [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
  ];

  const highEntropyValues = {
    architecture: 'x86',
    bitness: '64',
    fullVersionList: D.fullVersionList,
    mobile: false,
    model: '',
    platform: 'Windows',
    platformVersion: '15.0.0',
    uaFullVersion: D.version,
    wow64: false
  };

  const userAgentData = {
    brands: D.brands,
    mobile: false,
    platform: 'Windows',
    getHighEntropyValues: (hints) => new Promise((resolve) => {
      const result = {};
      (hints || []).forEach((hint) => {
        if (hint in highEntropyValues) result[hint] = highEntropyValues[hint];
      });
      resolve(result);
    }),
    toJSON: () => ({ brands: D.brands, mobile: false, platform: 'Windows' })
  };

  const nav = navigator;

  try {
    delete window.process;
    delete window.require;
    delete window.module;
    delete window.exports;
  } catch (err) { /* ignore */ }

  defineGetter(nav, 'webdriver', false);
  defineGetter(nav, 'userAgent', D.userAgent);
  defineGetter(nav, 'appVersion', D.userAgent.replace(/^Mozilla\\//, '5.0 '));
  defineGetter(nav, 'appName', 'Netscape');
  defineGetter(nav, 'platform', 'Win32');
  defineGetter(nav, 'vendor', 'Google Inc.');
  defineGetter(nav, 'product', 'Gecko');
  defineGetter(nav, 'languages', ['en-US', 'en']);
  defineGetter(nav, 'language', 'en-US');
  defineGetter(nav, 'hardwareConcurrency', 8);
  defineGetter(nav, 'deviceMemory', 8);
  defineGetter(nav, 'maxTouchPoints', 0);
  defineGetter(nav, 'plugins', buildArrayLike(plugins));
  defineGetter(nav, 'mimeTypes', buildArrayLike(mimeTypes));
  defineGetter(nav, 'pdfViewerEnabled', true);
  defineGetter(nav, 'userAgentData', userAgentData);

  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.app = window.chrome.app || {};
  window.chrome.webstore = window.chrome.webstore || {};
  window.chrome.csi = window.chrome.csi || (() => ({
    onloadT: Date.now(),
    pageT: performance.now(),
    startE: performance.timeOrigin,
    tran: 15
  }));
  window.chrome.loadTimes = window.chrome.loadTimes || (() => ({
    commitLoadTime: performance.timeOrigin / 1000,
    connectionInfo: 'h2',
    finishDocumentLoadTime: performance.now() / 1000,
    finishLoadTime: performance.now() / 1000,
    firstPaintAfterLoadTime: 0,
    firstPaintTime: performance.now() / 1000,
    navigationType: 'Other',
    npnNegotiatedProtocol: 'h2',
    requestTime: performance.timeOrigin / 1000,
    startLoadTime: performance.timeOrigin / 1000,
    wasAlternateProtocolAvailable: false,
    wasFetchedViaSpdy: true,
    wasNpnNegotiated: true
  }));

  if (navigator.permissions && navigator.permissions.query) {
    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (descriptor) => {
      if (descriptor && descriptor.name === 'notifications') {
        return Promise.resolve({ name: 'notifications', state: Notification.permission });
      }
      return originalQuery(descriptor);
    };
  }

  if (nav.connection) {
    defineGetter(nav.connection, 'rtt', 50);
    defineGetter(nav.connection, 'downlink', 10);
    defineGetter(nav.connection, 'effectiveType', '4g');
  }

  const patchWebGl = (Ctor) => {
    if (!Ctor || !Ctor.prototype || !Ctor.prototype.getParameter) return;
    const originalGetParameter = Ctor.prototype.getParameter;
    Ctor.prototype.getParameter = function patchedGetParameter(parameter) {
      if (parameter === 37445) return 'Google Inc. (NVIDIA)';
      if (parameter === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5050 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return originalGetParameter.call(this, parameter);
    };
  };

  patchWebGl(window.WebGLRenderingContext);
  patchWebGl(window.WebGL2RenderingContext);
})();`;
}
