# Changelog

## 1.6.0 — 2026-10-28

### Added

- **Local history index.** Every conversation you open is captured after it
  renders and stored in `history/entries.jsonl` in the app's data folder, so
  global search finds chats that are no longer open. Captured text excludes the
  sidebar, and nothing leaves the machine.
- **Chat-list harvesting.** Conversation titles and links are read from each
  service's own sidebar with site-agnostic heuristics, so the whole history
  becomes searchable by title immediately, without opening every chat.
- **Background indexing.** An opt-in run inside a hidden, off-screen window
  fills the full text of older conversations. It is sequential, pauses 3–8
  seconds between chats, takes a longer break every twelve, and stops on
  `429`/`403`, a captcha or a "verify you are human" page. A bar at the bottom
  of the window shows the current conversation title, the count and a Stop
  button.
- **ChatGPT server-side history in global search.** When a ChatGPT tab is open,
  its own full-text conversation index is queried as well, so chats this app
  never opened show up with server-rendered snippets.
- **Settings → History search** with two switches, **Index now**, **Stop**,
  **Clear index** and a stored-size summary.
- **Confirmation with an estimate.** Starting a run first shows how many
  conversations were found per service and roughly how long it will take.
- **Manual runs cover every service.** `Index now` walks the loaded services in
  order, starting with the active tab and pausing 15–30 s between them; the
  confirmation also offers **Only <service>**. One report groups the failures by
  service.
- **Report after a run.** Saved, queued and failed counts; failed conversations
  are listed with a reason and a link, and opening one adds it to the index.
- **Automatic top-ups.** With background indexing on, a new (or re-added)
  service is checked two minutes after it is added, and each service is
  re-checked at most once every six hours. Only conversations without stored
  text are queued, at most fifteen per pass, at the same human pace.
- **History is dropped with its tab.** Closing a service deletes the
  conversations captured for it, matching the existing "closing a tab wipes its
  profile" behaviour, so a re-added service starts from its current list.

### Changed

- Global search now merges three sources — indexed history, live open pages and
  the ChatGPT service index — instead of scanning only the rendered tabs.
- Search results are grouped into sections and show the service, a snippet, a
  `title only` badge and when the chat was captured.
- The sidebar is stripped from captured conversations, so snippets start with
  the conversation instead of the chat list.
- Re-visiting a chat no longer appends an identical row: a capture is written
  only when the text or the title actually changed.
- The indexing bar shows a static, centred conversation title instead of a
  marquee, plus the position in a multi-service run (`3/7`).

### Fixed

- **Index now reads the local queue, not only the visible sidebar.** Older
  conversations and ChatGPT project chats are re-read even when they are no
  longer in the chat list, so the run can actually finish the index instead of
  reporting “nothing to do” while conversations without text remain.
- The estimate and the report count queued conversations. The report says how
  many are still left in the queue and no longer claims everything was saved
  when the run only covered the visible list. “Queued” became “attempted”.
- Automatic top-ups no longer open the report dialog; only a manual run does.
- A queued conversation that is already indexed under another URL variant is
  dropped, and several variants of the same chat are collapsed into one.
- Navigation labels such as “Skip to main content” are no longer stored as chat
  titles; a queued row with no other title falls back to the service name.
- The conversation identity now uses the last id segment in the URL, so two
  chats inside one ChatGPT project are no longer treated as the same chat when
  a page redirects.

### Notes

- Background indexing is off by default: a burst of automated page loads is what
  makes a service treat an app as a bot.
- `ALLAI_INDEX_MAX` and `ALLAI_INDEX_DELAY_MS` override the run size and pacing
  for local testing only.

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
