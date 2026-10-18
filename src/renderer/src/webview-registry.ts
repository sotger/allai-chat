const webviews = new Map<string, Electron.WebviewTag>();

export const webviewRegistry = {
  set(tabId: string, webview: Electron.WebviewTag | null): void {
    if (webview) webviews.set(tabId, webview);
    else webviews.delete(tabId);
  },
  get(tabId: string | null): Electron.WebviewTag | undefined {
    return tabId ? webviews.get(tabId) : undefined;
  }
};

/** Runs a webview method, ignoring the "not attached / not dom-ready" errors. */
export function withWebview(tabId: string | null, action: (webview: Electron.WebviewTag) => void): void {
  const webview = webviewRegistry.get(tabId);
  if (!webview) return;
  try {
    action(webview);
  } catch { /* webview not ready yet */ }
}
