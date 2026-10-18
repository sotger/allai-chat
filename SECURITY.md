# Security Policy

## Supported versions

Only the latest release published on the
[Releases](https://github.com/sotger/allai-chat/releases) page receives security
fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
private vulnerability reporting:

1. Open the [Security tab](https://github.com/sotger/allai-chat/security).
2. Click **Report a vulnerability**.
3. Include the app version, your OS, reproduction steps and the impact you
   expect.

You can expect an initial response within a few days. Once a fix is available,
the advisory will be published together with the release notes.

## Scope

In scope:

- The Electron shell: window/webview configuration, preload scripts, IPC
  handlers, session and permission handling, navigation restrictions.
- Local data handling: anything the app writes outside the documented
  `ALLAI-CHAT` user-data folder, or credentials the app stores itself.
- Release artifacts: tampered builds, unexpected network requests made by the
  app shell (not by the websites you open).

Out of scope:

- Vulnerabilities in the AI services themselves (report those to the provider).
- The fact that unsigned builds trigger SmartScreen/Gatekeeper warnings.
- Google/Microsoft blocking embedded sign-in or changing their detection.
- Malicious content on a website you deliberately open in a tab — the app is a
  browser, and sites run with normal browser privileges.

## Design notes

- `contextIsolation` is enabled and `nodeIntegration` is disabled in the UI.
- The renderer only gets the API exposed in `src/preload/index.ts`; there is no
  generic `ipcRenderer` bridge.
- Guest pages are restricted to `http(s)` navigation; popups are either routed
  to a session-sharing sign-in window for trusted auth hosts or opened in the
  system browser.
- Permissions are allow-listed. Camera and microphone requests prompt the user;
  clipboard read, geolocation and idle detection are denied.
- Closing a tab wipes its Chromium partition data.
- The app has no backend, telemetry or auto-update service.

Reports that demonstrate a way to escape these boundaries are especially
welcome.
