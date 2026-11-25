#!/usr/bin/env bash
# Puts ALLAI-CHAT back into "first launch" state:
#   • quits the app and Safari (a running Safari rewrites its cookie file on quit)
#   • removes the app profile in ~/Library/Application Support/ALLAI-CHAT
#   • removes Safari's cookie store (every site, one file)
#
# Destructive by design. It never touches anything outside the paths printed by
# --dry-run, and it refuses to run when a target does not live under $HOME.
#
# Usage:
#   scripts/reset-test-state.sh                 # lists targets, asks first
#   scripts/reset-test-state.sh --dry-run       # only lists targets
#   scripts/reset-test-state.sh --yes           # no confirmation
#   scripts/reset-test-state.sh --kill-safari   # force-quit Safari if it hangs
#   scripts/reset-test-state.sh --reset-tcc     # also drop macOS permission grants
#   scripts/reset-test-state.sh --yes --kill-safari --reset-tcc
#
# Notes:
#   • Deleting Safari's cookies needs Full Disk Access for the terminal itself.
#     Without it the script reports "Operation not permitted" and stops; grant
#     the terminal the same permission or delete the file from Finder.
#   • --reset-tcc makes macOS forget the Full Disk Access / Automation grants for
#     ALLAI-CHAT, so the next launch is a true first run. It resets only this app.
set -uo pipefail

APP_NAME="ALLAI-CHAT"
BUNDLE_ID="com.allaichat.app"
APP_BINARY="/Applications/${APP_NAME}.app/Contents/MacOS/${APP_NAME}"

PROFILE_DIR="${HOME:?HOME is not set}/Library/Application Support/${APP_NAME}"
PREFS_FILE="${HOME}/Library/Preferences/${BUNDLE_ID}.plist"
SAFARI_COOKIES=(
  "${HOME}/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"
  "${HOME}/Library/Cookies/Cookies.binarycookies"
)

ASSUME_YES=false
DRY_RUN=false
KILL_SAFARI=false
RESET_TCC=false

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=true ;;
    --dry-run|-n) DRY_RUN=true ;;
    --kill-safari) KILL_SAFARI=true ;;
    --reset-tcc) RESET_TCC=true ;;
    -h|--help)
      # Header comment block only: everything up to the first non-comment line.
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }

# Everything this script deletes must sit below $HOME. Fail loudly otherwise,
# rather than removing a path that resolved somewhere unexpected.
assert_under_home() {
  local target="$1"
  case "$target" in
    "${HOME}/"*) return 0 ;;
    *)
      warn "refusing to delete a path outside \$HOME: $target"
      return 1
      ;;
  esac
}

remove_target() {
  local target="$1"
  assert_under_home "$target" || return 1

  if [[ ! -e "$target" ]]; then
    say "  – not present   $target"
    return 0
  fi

  if $DRY_RUN; then
    say "  would delete    $target"
    return 0
  fi

  if rm -rf -- "$target" 2>/dev/null && [[ ! -e "$target" ]]; then
    say "  deleted         $target"
    return 0
  fi

  warn "  FAILED          $target"
  warn "                  (permission denied — the terminal needs Full Disk Access)"
  return 1
}

app_running() { pgrep -f "${APP_NAME}.app/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1; }
safari_running() { pgrep -x Safari >/dev/null 2>&1; }

quit_app() {
  app_running || return 0
  say "Quitting ${APP_NAME}…"
  osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    app_running || return 0
    sleep 0.25
  done
  pkill -f "${APP_NAME}.app/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1 || true
  sleep 0.5
  app_running && warn "${APP_NAME} is still running."
  return 0
}

quit_safari() {
  if ! safari_running; then
    say "Safari           not running"
    return 0
  fi

  say "Quitting Safari…  (it rewrites its cookie file on exit)"
  osascript -e 'tell application "Safari" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    safari_running || { say "Safari           closed"; return 0; }
    sleep 0.25
  done

  if $KILL_SAFARI; then
    warn "Safari did not quit; terminating it (--kill-safari)."
    pkill -x Safari >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      safari_running || { say "Safari           terminated"; return 0; }
      sleep 0.25
    done
  fi

  warn "Safari is still running. Close it and run this script again,"
  warn "or pass --kill-safari to let the script terminate it."
  return 1
}

reset_tcc() {
  say "Resetting macOS grants for ${BUNDLE_ID}…"
  for service in SystemPolicyAllFiles AppleEvents; do
    if $DRY_RUN; then
      say "  would reset     $service"
    elif tccutil reset "$service" "$BUNDLE_ID" >/dev/null 2>&1; then
      say "  reset           $service"
    else
      warn "  could not reset $service (harmless, the grant just stays)"
    fi
  done
}

say "ALLAI-CHAT test-state reset"
say ""
say "Targets:"
say "  $PROFILE_DIR"
say "  ${SAFARI_COOKIES[0]}"
say "  ${SAFARI_COOKIES[1]}"
$RESET_TCC && say "  TCC grants: SystemPolicyAllFiles, AppleEvents"
say ""

if $DRY_RUN; then
  say "Dry run: nothing will be removed."
  say ""
  say "Actions:"
  say "  1. quit ${APP_NAME} and Safari (only in a real run)"
  say "  2. remove the profile directory"
  say "  3. remove Safari's cookie store"
  $RESET_TCC && say "  4. reset the permission grants"
  say ""
  say "Present now:"
  for target in "$PROFILE_DIR" "${SAFARI_COOKIES[@]}"; do
    if [[ -e "$target" ]]; then
      say "  exists          $target"
    else
      say "  absent          $target"
    fi
  done
  exit 0
fi

if ! $ASSUME_YES; then
  say "This deletes the app profile (tabs, logins, history index) and every Safari"
  say "cookie for this user. Nothing can be undone."
  say ""
  printf 'Type "reset" to continue: '
  read -r answer
  [[ "$answer" == "reset" ]] || { say "Cancelled."; exit 1; }
  say ""
fi

failures=0

quit_app
say ""
quit_safari || exit 1
say ""

say "Removing:"
remove_target "$PROFILE_DIR" || failures=$((failures + 1))
for cookie_file in "${SAFARI_COOKIES[@]}"; do
  remove_target "$cookie_file" || failures=$((failures + 1))
done

# AppKit writes this on every save-panel use; it is not part of the profile.
if [[ -e "$PREFS_FILE" ]]; then
  remove_target "$PREFS_FILE" || failures=$((failures + 1))
fi

if $RESET_TCC; then
  say ""
  reset_tcc
fi

say ""
if (( failures > 0 )); then
  warn "Done with ${failures} failure(s). Fix the permission problem and run again."
  exit 1
fi

say "Done. Next launch is a first launch:"
say "  1. open  /Applications/${APP_NAME}.app"
say "  2. if macOS asks for Full Disk Access, allow it, come back"
say "  3. the dialog should go green on its own within a second or two"
say ""
say "The app writes its new profile to:"
say "  $PROFILE_DIR"
say "and its handoff log to:"
say "  ${PROFILE_DIR}/browser-sign-in.log"
