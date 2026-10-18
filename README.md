# ALLAI-CHAT

[![CI](https://github.com/sotger/allai-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/sotger/allai-chat/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sotger/allai-chat)](https://github.com/sotger/allai-chat/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**All your AI chats in one desktop app.** ALLAI-CHAT is a small Electron browser
for ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek, Grok and other AI
services. Each service lives in a vertical tab with its own isolated profile, so
you can stay signed in to several accounts without mixing cookies.

You do not need API keys, and nothing is proxied through a third-party server:
the app simply loads the real AI websites, like a dedicated browser with
profiles.

## Features

- **Vertical tabs** — one tab per AI service, drag to reorder, double-click to
  rename, switch instantly with the sidebar or `Cmd/Ctrl+1…9`.
- **Isolated sessions** — every tab runs in its own Electron partition with its
  own cookies and storage. Add the same service twice to use two accounts.
- **Google and Microsoft sign-in work** — login popups open in a dedicated
  window that shares the tab's session.
- **Tabs stay loaded** — no reload when switching; audio from inactive tabs is
  muted automatically.
- **Browser basics** — back / forward / reload, find in page, zoom, downloads,
  native context menu with Cut / Copy / Paste, camera and microphone support.
- **Persistent workspace** — tabs, order, active tab, labels and window size are
  restored on the next launch.
- **No telemetry** — no analytics, no accounts, no cloud sync, no auto-update
  pings. The app only talks to the services you open.

Included services: ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek, Grok,
HuggingChat, Kimi, ChatGLM, Le Chat (Mistral), You.com, Phind, Poe, plus any
custom URL.

## Install

Prebuilt, **unsigned** installers are published on the
[Releases](https://github.com/sotger/allai-chat/releases/latest) page. There is
no auto-update — download a newer release to upgrade; your tabs and logins are
kept.

### macOS (Apple Silicon and Intel)

1. Download the build that matches your Mac:
   - Apple Silicon (M1–M4): `ALLAI-CHAT-<version>-arm64.dmg`
   - Intel: `ALLAI-CHAT-<version>-x64.dmg`
2. Open the `.dmg` and drag **ALLAI-CHAT** into **Applications**.
3. The build is not notarized by Apple. On first launch either right-click the
   app → **Open**, or clear the quarantine flag once:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/ALLAI-CHAT.app"
   open "/Applications/ALLAI-CHAT.app"
   ```

Requires macOS 13 (Ventura) or newer (Electron 44 / Chromium 152).

### Windows 10 / 11

1. Download `ALLAI-CHAT-<version>-x64.exe`.
2. Run the installer (per-user, no administrator rights required).
3. The build is not code-signed: if SmartScreen appears, choose
   **More info → Run anyway**.

### Linux

**AppImage (any distribution)**

```bash
chmod +x ALLAI-CHAT-<version>-x86_64.AppImage
./ALLAI-CHAT-<version>-x86_64.AppImage
```

On Ubuntu 22.04+ the AppImage runtime needs FUSE 2:
`sudo apt install libfuse2`. If the Chromium sandbox is blocked by your
distribution, start the app with `--no-sandbox` (less secure).

**Debian / Ubuntu (.deb)**

```bash
sudo apt install ./ALLAI-CHAT-<version>-amd64.deb
```

Then start **ALLAI-CHAT** from your application menu, or run `allai-chat`.

### Build from source

Requirements: Node.js **20.19+** or **22.12+** (Vite 7), npm.

```bash
git clone https://github.com/sotger/allai-chat.git
cd allai-chat
npm install
npm run dev
```

Build installers locally:

```bash
npm run dist:mac        # macOS DMG for the current architecture
npm run dist:mac:all    # macOS DMGs for Intel + Apple Silicon
npm run dist:win        # Windows NSIS installer (also cross-builds from macOS)
npm run dist:linux      # AppImage + .deb (build on Linux)
```

Artifacts are written to `dist-electron/`. Official release builds are produced
by the [release workflow](.github/workflows/release.yml) for macOS (arm64 and
x64), Windows (x64) and Linux (x64).

## Using the app

1. Click **+ Add service** (or `Cmd/Ctrl+T`) and pick a provider.
2. Sign in as you normally would on that website — for example
   **Continue with Google**.
3. Click another tab to switch services. Each tab keeps its own login.
4. To use a second account, add the same provider again; it gets its own session
   and is labelled `ChatGPT 2`, `Gemini 2`, etc.

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+1…9` | Switch to service 1–9 |
| `Cmd/Ctrl+T` | Add service |
| `Cmd/Ctrl+W` | Close current service |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous service |
| `Cmd/Ctrl+R` | Reload service |
| `Cmd/Ctrl+Shift+R` | Force reload (ignore cache) |
| `Cmd/Ctrl+F` | Find in page |
| `Cmd/Ctrl+Plus` / `-` / `0` | Zoom in / out / reset |

Closing a tab deletes that tab's profile (cookies, cache, storage) from disk, so
reopening it means signing in again. This keeps stale credentials from piling up.

## Security and privacy

ALLAI-CHAT is a local browser shell. It does not have a backend, an account
system, telemetry, crash reporting or analytics. The only network traffic is the
traffic generated by the AI websites you open.

What the app itself stores:

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Application Support/ALLAI-CHAT` |
| Windows | `%APPDATA%\ALLAI-CHAT` |
| Linux | `~/.config/ALLAI-CHAT` |

This folder contains only window state, the tab list and per-tab Chromium
profiles (cookies and site storage). The app never sees or stores your passwords:
sign-in happens on the provider's own website, and cookies are handled by
Chromium. Deleting a tab removes its profile from disk.

Hardening in the current build:

- `contextIsolation` enabled and `nodeIntegration` disabled for the UI; the
  renderer can only call the small IPC surface exposed in `src/preload`.
- Guest pages may only navigate to `http(s)`. Other schemes and popups are
  blocked; ordinary links open in your system browser.
- Permission requests are allow-listed: notifications, fullscreen, pointer lock
  and storage access. Camera/microphone access always shows a native
  confirmation for the requesting site; clipboard **read**, geolocation and idle
  detection are denied.
- Popups get an in-app, session-sharing window only for trusted sign-in hosts
  (Google, Microsoft, Apple, GitHub, the service's own domain). Everything else
  opens in your system browser, so a page cannot show you a chromeless login
  form for an unrelated site.
- A Content-Security-Policy limits the app's own UI to local resources.
- No `eval`, no remote code, no third-party scripts in the app shell.

Privacy notes:

- The AI services you open have their own terms and privacy policies and will
  receive the usual browser data (IP address, cookies, user agent).
- To let Google/Microsoft sign-in work inside an Electron window, the app
  presents a regular Chrome user agent and client hints on the page level. This
  happens locally; no additional data is sent anywhere.
- Release builds are unsigned. If you prefer, build from source or verify the
  artifacts from the GitHub Actions run for the release.

If you find a security issue, please follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.

## Tech stack

Electron 44 · Chromium 152 · React 19 · TypeScript · Zustand · Vite 7 ·
electron-vite · electron-builder.

```
src/
├── main/index.ts        # window, tab state, sessions, menus, IPC
├── preload/
│   ├── index.ts         # window.allai bridge
│   ├── webview.ts       # guest preload (main-world fingerprint patch)
│   └── fingerprint.ts   # self-contained Chrome fingerprint script
├── shared/              # types, provider list, tab helpers, IPC contract
└── renderer/src/        # React UI: sidebar, service host, add-service dialog
scripts/
├── generate-icon.mjs    # dependency-free app icon generator
└── install-mac.mjs      # build + install into /Applications
```

### Maintainer notes

- `out/preload/webview.cjs` must stay in `build.asarUnpack`: Electron loads guest
  preloads through Node's `require`, which cannot read asar archives. Without it
  Google shows "This browser or app may not be secure".
- Keep the user agent and client-hint values in `src/main/index.ts` in sync with
  `src/preload/webview.ts`.

## License

MIT — see [LICENSE](LICENSE).

ALLAI-CHAT is based on [AI BANK](https://github.com/onlyvictus-bit/ai-bank) by
Sakthi Kuppan (MIT). The multi-panel broadcast dashboard was replaced with the
tabbed browser you see here.

ALLAI-CHAT is not affiliated with OpenAI, Anthropic, Google, Microsoft or any
other AI provider. All product names and trademarks belong to their owners.
