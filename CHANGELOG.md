# Changelog

## 1.9.0 — 2026-11-24

### Added

- **Sign in with cookies, for services that only accept passkeys.** Apple's
  **Sign in with iPhone** and other WebAuthn buttons cannot complete inside
  Electron, so the tab context menu now has **Import cookies…**:
  - on macOS a passkey button now hands itself off: if Safari already holds a
    session for the service it is taken over instantly, otherwise the app opens
    the service in Safari, watches Safari's cookie store for up to 10 minutes and
    takes the session over as soon as the login writes it, then returns the tab
    to the service (needs Full Disk Access for the app). The dialog also has
    **Open in Safari and wait** and **Take the session from Safari now**;
  - on every platform you can paste a Netscape `cookies.txt` export or a
    `Cookie:` header, or load the file with **Choose file…**.
  Only cookies belonging to the tab's own host are written; everything else in
  the file is ignored, and values are never logged or synced.

### Fixed

- **The Safari handoff now waits for a real session.** Device ids and Cloudflare
  cookies appear the moment the browser opens the page; they used to end the
  watch immediately, so the tab was reloaded still logged out and the session
  that arrived a minute later was missed. Only a session cookie ends the watch.
- **The app comes to the front when the browser session arrives**, so the user
  does not have to switch back from Safari by hand.
- **Passkey sign-in no longer hangs the page.** Electron cannot service
  WebAuthn authenticator requests (no platform authenticator is configured and
  there is no security-key or phone-QR UI), so a site that asks for one never
  got an answer. Apple's **Sign in with iPhone** was the visible case: the
  button spun on “Verifying…” forever and the Apple ID form became unusable.
  Passkey requests are now rejected immediately, so the page falls back to its
  normal sign-in, and a one-time notice explains that passkeys — including
  “Sign in with iPhone” — are not available in the app and that the password
  (plus the two-factor code on the phone) still works.


### Added — 2026-11-25 (browser handoff and permissions)

- **The browser handoff is no longer passkey-only.** When a tab, or the sign-in
  popup it opened, navigates itself to a sign-in provider (`accounts.google.com`,
  `login.microsoftonline.com`, `appleid.apple.com`, GitHub, Clerk, …), the app
  behaves exactly as it does for a blocked passkey: it takes the session Safari
  already holds for the service, or opens the service in Safari when there is
  none. **Continue with Google** now finishes instead of leaving a dead form in
  the tab.
- **Session cookies are matched per service.** `ProviderConfig.sessionCookiePattern`
  lets a service declare what "signed in" looks like — Google's `SID`/`__Secure-*PSID`
  family for Gemini, `sessionKey` for Claude — instead of assuming ChatGPT's
  `*session-token`. Without it the watch kept waiting until its 10-minute deadline.
- **Permissions are checked at startup**, not the first time a service needs
  them. A dialog lists every check with `Allowed` / `Missing` / `Not checked`, an
  alarm strip stays on screen while something is missing, and the dialog closes
  itself as soon as the grants land. `Full Disk Access` is the only required one;
  `Control Safari` is optional and is not requested at startup anymore (the Apple
  Event itself is what makes macOS show its Automation prompt, and the permission
  only closes the Safari tab afterwards).
- **The browser gives focus back.** After a successful import the app closes the
  Safari tab it opened and activates itself, so the user does not have to switch
  back by hand.
- **Deep sign-in entries.** The handoff opens ChatGPT's `/auth/login` (and
  `/auth/login_with?connection=apple` for a blocked passkey) instead of the
  service home page; a deep link is only used when it stays on the tab's host.

### Fixed — 2026-11-25

- **Endless bounce between a service and its sign-in provider.** The first version
  of the handoff re-imported and re-navigated on every auth navigation; on Gemini
  that produced 24 imports in 11 seconds, no browser window and no login. A
  per-tab guard now allows at most two attempts a minute and is only lifted when
  a normal page finishes loading.
- **Imported Safari cookies do work for Google.** Verified on Gemini: the tab
  loads `gemini.google.com` signed in after `imported 22` cookies. The earlier
  failure was the bounce above, not Google rejecting the session.
- **Packaged builds keep the guest preload.** Importing a shared module into
  `src/preload/webview.ts` made Rollup split a `chunks/ipc-*.cjs` file that a
  sandboxed preload cannot require from inside the asar — the preload failed to
  load and `window.allai` disappeared. The channel name is a literal again.

### Added — 2026-11-25 (shared Google session, per-tab handoff)

- **The shared Google session is filled by the browser handoff.** The vault was
  written only by the OAuth-popup paths, which the handoff replaced, so a login
  that finished in Safari left it empty and every next service had to go back to
  the browser. A successful import now stores Safari's whole Google cookie set
  (every `*.google.com` host, not three addresses) — a partial copy loses the
  account chooser.
- **Settings shows what is stored.** **Settings → Google sign-in** reports
  “Saved on this Mac — N Google cookies” or “No Google session saved yet”,
  **Apply to services** enables only when there is something to apply, and
  **Google accounts…** opens Google's own account chooser inside the app's
  profile, where further accounts can be added or switched.
- **A different account no longer replaces the stored one.** The vault keeps a
  short, non-reversible hash of the session cookie. When a handoff used another
  account, the stored login is kept and the app says so instead of silently
  changing which account every new tab receives.
- **Right-click a tab → Sign in via Safari (another account)…** finishes a single
  login in the browser, where another account can be chosen, skipping both the
  stored session and the session Safari already holds.

### Fixed — 2026-11-25 (later)

- **Grok was never recognised as signed in.** Its session lives in `sso` /
  `sso-rw`, not in anything named `session`, so the import wrote the cookies and
  then kept waiting until the deadline. `grok.com` now declares
  `sessionCookiePattern: '^sso(-rw)?$'` (verified on a real login).
- **One handoff no longer cancels another.** The watcher was a single global, so
  starting a login in another service silently stopped the one already waiting in
  the browser; that login then finished with nobody watching. Watchers are per
  tab now.
- **A tab that receives the shared session is reloaded.** Copying cookies into a
  page that had already rendered left it sitting on its signed-out state.
- **The handoff log names the cookies it sees** — `waiting: 4 new cookie(s), no
  session yet (sso, sso-rw)` — names only, never values. That is what made the
  Grok rule visible instead of guessed.
- **Full Disk Access is reported honestly.** A Safari that has not written a
  cookie store yet used to show `Missing` even with the grant in place; the app
  now checks the cookie *folder* (the same TCC access) and reports
  `Not checked` only when there is genuinely nothing to read.


## 1.8.1 — 2026-11-23

### Fixed

- **Sync no longer claims "Already up to date" while another device's file was
  skipped.** A file that is still uploading, not downloaded from the cloud yet,
  or damaged is now counted and named in **Settings → Sync & backup** instead of
  disappearing silently. The next pass retries it, and the status line keeps
  reporting it until it is read.

## 1.8.0 — 2026-11-20

### Added

- **Sync and export the local index.** **Settings → Sync & backup** writes one
  portable `allai-history-<device>.json` per computer into a folder your cloud
  client already syncs (iCloud Drive, Google Drive, OneDrive, Dropbox,
  Nextcloud, a network share) and merges the other devices' files. There is no
  OAuth, API key or backend: the cloud app moves the file. **Export…** and
  **Import…** work without enabling cloud sync.
- Sync is conflict-aware: a per-conversation tombstone stops a deleted chat from
  coming back, **Clear index** propagates to the other devices, and an entry
  captured after a deletion survives. Rows are attached to a local tab by
  service, label and host; ambiguous tabs are skipped instead of mixing
  accounts.
- **Settings, updates and releases in the macOS application menu.** `ALLAI-CHAT`
  now contains **Settings…** (`Cmd+,`), **Check for Updates…** and **Releases on
  GitHub**; Windows and Linux keep Settings in **View** and get the release
  links in **Help**.
- **macOS self-update for ad-hoc builds.** Squirrel.Mac refused to install
  updates without a Developer ID, so the fallback updater talks to the GitHub
  API directly, downloads the matching Intel/Apple Silicon zip, verifies its
  SHA-256 digest, replaces the `.app` after quitting and relaunches it. If the
  bundle is not writable (mounted DMG, App Translocation), it opens the release
  page instead. Background checks ask once per version; **Check for Updates…**
  is always available.
- **Broadcast starts a new chat in every service.** **Send a prompt to all
  services** now clicks each service's "New chat" control (or opens its known
  new-conversation address) before typing, so the prompt no longer lands in
  whichever conversation was open. **Start a new chat first** can be unticked to
  keep the old behaviour, and per-service results say whether a new chat was
  started.

### Changed

- Update status is reported in the app's toast area: downloading percentage,
  "update downloaded" and errors, on every platform.
- The macOS menu no longer duplicates **Settings…** in **View**.
- Provider configs gained a `newChatUrl`, used only as a fallback when the site's
  own "New chat" control cannot be found.

### Fixed

- **Sync folder selection is reversible.** The detected cloud folders are always
  shown; each account has its own label (for example two Google Drive accounts
  include their addresses), the active one is checked, and the folder button
  says **Change…** once a folder is set.
- **Dialog headers stay visible.** The title and the close button of Settings,
  Broadcast and the other modal windows are sticky, so scrolling the body never
  hides the ×.
- **Broadcast send is verified.** After the text is inserted, the app waits for
  an enabled send control, clicks it and reads the composer back. Sending makes
  each tab briefly visible/focused (some services ignore a background click —
  Gemini and DeepSeek were the reported cases), falls back to one native Return
  if the click did nothing, and reports "inserted — send button did not respond"
  instead of claiming success. The previous tab is restored afterwards.
- **Changing the sync folder works immediately.** The snapshot cache was tied to
  the data, not to the folder, so after switching folders (or deleting the JSON
  file) a sync could skip the write, fail with `ENOENT` on the new folder and
  leave no file at all. The cache is now per folder, the app checks that its own
  file still exists, and **Sync now** waits for an in-flight pass before running
  again.
- **Clear index** now records a sync-wide clear marker, so a cloud copy cannot
  restore what was just deleted.
- Closing a service tab records a local-only tombstone: its conversations do not
  return from the cloud, but the same service on another computer is untouched.

## 1.7.3 — 2026-10-30

### Fixed

- **Claude's full `/chats` list is harvested.** The list is a table in `main`
  (not `role=row`), so the main scroller was never touched and only the recent
  sidebar chats were indexed. The deep harvest now scrolls `main` when it holds
  a chat list (table anchors or `role=row`), collecting the virtualized rows.
  On the author's profile this found **38** chats instead of 30, including the
  oldest from April 2024.
- The Perplexity library path is unaffected; both use the same main-list
  scroll.

## 1.7.2 — 2026-10-30

### Fixed

- **Utility pages are no longer captured as conversations.** `/chats`,
  `/library`, `/projects`, `#subscribe`, sign-in screens and private-link/access
  walls are rejected by the capture path, and rows already stored from older
  builds are dropped when the index loads. On the author's profile this removed
  five junk rows (Claude `/chats` and `/projects`, Grok `/subscribe` and a
  private link, Perplexity `/library`).
- **“View all” buttons are followed, not only links.** Claude renders its
  “View all” control as a button that navigates to `/chats`; the hidden
  harvester now clicks it and reads the full list. Grok's “See all” opens a
  command menu without changing the URL, so it is left alone.
- **Capture reads `<main>`, not the whole page.** Grok's root wrapper has
  `group/sidebar-wrapper` in its class, and the old `[class*=sidebar]` filter
  hid the entire conversation. Reading the main element (with a 10 s timeout)
  captured the Grok chat as 6,629 characters instead of 92.
- Perplexity's `/library` row is also removed from existing indexes; the 586
  queued conversations are unaffected.

### Notes

- Grok's account currently exposes **one** accessible conversation in
  “See all” (plus an inaccessible private link), and Claude's `/chats` lists
  **30** unique chats — all 30 are already indexed. The large hidden backlog was
  specific to Perplexity (588 chats).

## 1.7.1 — 2026-10-30

### Fixed

- **Perplexity's full history is discovered.** The library (`View all`) renders
  its sessions as `div[role=row]` without links, so harvesting only saw the
  recent sidebar. The app now follows a “View all” link from a chat page, reads
  the row's `href`/title from the React props, scrolls the main list and adds
  every session to the unindexed queue. On the author's profile this found 588
  conversations instead of the 34 visible in the sidebar.
- Deep harvesting now scrolls the main content list (not only `nav`/`aside`),
  collects up to 3,000 links and allows 60 seconds for the pass.
- Titles from list rows are capped at 200 characters so a long prompt does not
  become an unwieldy queue row.

## 1.7.0 — 2026-10-30

### Added

- **Unindexed conversations panel.** `Cmd/Ctrl+Shift+U`, **View → Unindexed
  Conversations** or the **▤** button opens a right-hand panel listing every
  conversation that has a title but no captured text, grouped by service. It is
  resizable (240–460 px, remembered per machine) and turns into an overlay on
  narrow windows.
- Each row opens the chat in its tab; the row disappears as soon as the text is
  captured. A filter narrows long lists, **×** removes a row from the queue, and
  **Refresh list** re-reads the service sidebars for new titles.
- **Live progress in the panel** while indexing: conversations left, saved and
  failed, the current service and chat, a progress bar and **Stop**. The top-bar
  button carries the queue count.
- **Full manual runs.** A manual run now works through the whole local queue
  instead of the first 60 per service. 2,000 chats per service remains only as a
  runaway guard; **Stop** ends the run at any point.

### Changed

- The confirmation dialog says when the queue will be read to the end and that
  the estimate includes rows that are no longer visible in the chat list.
- Automatic top-ups remain small passes and never open the report.
- The report shows **left in queue**, **attempted** instead of “queued”, and a
  stopped run is labelled as such.

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
