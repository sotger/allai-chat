# Changelog

## 1.5.0 — 2026-10-27

### Added

- **Resizable sidebar.** Drag the right edge of the sidebar between 140 and
  420 px; double-click the edge to reset it to 152 px. The width is remembered
  between launches. The control is hidden in the 64 px icon rail.
- **Interface size.** Settings → Interface size offers 13 (default), 14, 15 and
  16 px for the app shell (sidebar, toolbar, dialogs). Websites keep their own
  zoom level.
- **Send a prompt to all services.** `Cmd/Ctrl+Shift+Enter`, the ⇉ top-bar
  button, or View → Send Prompt to All Services… inserts the same prompt into
  every open service. Insert-only by default; an opt-in checkbox also presses
  send. Per-service results report failures instead of failing silently.
- **Chat-title search hits.** Results that exist only in a service's chat list
  are labelled `chat title`; clicking one opens that chat before highlighting
  the match.

### Fixed

- **Tabs reopened at the service root instead of the open conversation.** The
  current URL is now persisted on every navigation, including SPA route
  changes, and restored on launch. This is also why search used to miss chats
  after a restart.
- **Search missed phrases split across inline elements** (for example
  `Ctrl` + `+` + `Space` rendered as separate spans). Search now runs over the
  rendered text (`innerText`) and also scans shadow roots.
- **The search panel did not explain why a service had no matches.** It now
  lists the services that were scanned without a match and the number of
  characters scanned.
- **Le Chat renamed to Mistral Vibe.** Saved tabs are migrated automatically.
- **You.com removed from the add-service list.** Existing You.com tabs keep
  working; the provider config is retained for backward compatibility.

### Changed

- Search panel can grow taller (up to 82 vh) so all services fit without
  scrolling on a typical window.
- The two search controls in the top bar are now 36 × 36 px chips with an 8 px
  gap and an inline `all` label; previously they were bare 28 × 28 px icons.

Earlier releases: see [GitHub Releases](https://github.com/sotger/allai-chat/releases).
