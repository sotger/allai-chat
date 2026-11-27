#!/usr/bin/env bash
# Closes Safari and deletes its cookie store — nothing else.
#
# This is the lightweight companion to reset-test-state.sh: the same Safari
# step, but it keeps the app profile, the local index and the macOS permission
# grants. Use it when a sign-in test must start from "no browser session", for
# example before checking ALLAI-CHAT's Safari handoff again.
#
# Usage:
#   scripts/clear-browser.sh               # lists targets, asks first
#   scripts/clear-browser.sh --dry-run     # only lists targets
#   scripts/clear-browser.sh --yes         # no confirmation
#   scripts/clear-browser.sh --kill        # force-quit Safari if it hangs
#
# Notes:
#   • Safari rewrites its cookie file when it quits, so it is closed first and
#     the file is removed afterwards. Deleting the file while Safari runs is
#     pointless: the running app writes its own store back.
#   • Removing the file needs Full Disk Access for the terminal. Without it the
#     script reports "permission denied" and exits non-zero.
#   • It does not touch ALLAI-CHAT's profile, its Google session vault
#     (persist:allai-google-signin) or any macOS permission grant.
set -uo pipefail

SAFARI_COOKIES=(
  "${HOME:?HOME is not set}/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"
  "${HOME}/Library/Cookies/Cookies.binarycookies"
)

ASSUME_YES=false
DRY_RUN=false
KILL_SAFARI=false

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=true ;;
    --dry-run|-n) DRY_RUN=true ;;
    --kill) KILL_SAFARI=true ;;
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

safari_running() { pgrep -x Safari >/dev/null 2>&1; }

# Everything this script deletes must sit below $HOME.
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
    warn "Safari did not quit; terminating it (--kill)."
    pkill -x Safari >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      safari_running || { say "Safari           terminated"; return 0; }
      sleep 0.25
    done
  fi

  warn "Safari is still running and would rewrite the cookie file."
  warn "Close it and run the script again, or pass --kill."
  return 1
}

remove_cookie_file() {
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

  if rm -f -- "$target" 2>/dev/null && [[ ! -e "$target" ]]; then
    say "  deleted         $target"
    return 0
  fi

  warn "  FAILED          $target"
  warn "                  (permission denied — the terminal needs Full Disk Access)"
  return 1
}

say "Safari cookie reset"
say ""
say "Targets:"
for target in "${SAFARI_COOKIES[@]}"; do
  say "  $target"
done
say ""

if $DRY_RUN; then
  say "Dry run: nothing will be closed or removed."
  say ""
  say "Actions:"
  say "  1. quit Safari (only in a real run)"
  say "  2. remove the cookie store above"
  say ""
  say "Present now:"
  for target in "${SAFARI_COOKIES[@]}"; do
    if [[ -e "$target" ]]; then
      say "  exists          $target"
    else
      say "  absent          $target"
    fi
  done
  exit 0
fi

if ! $ASSUME_YES; then
  say "This signs Safari out of every site: all of its cookies are deleted."
  say "The app profile and the Google vault are not touched. Nothing can be undone."
  say ""
  printf 'Type "clear" to continue: '
  read -r answer
  [[ "$answer" == "clear" ]] || { say "Cancelled."; exit 1; }
  say ""
fi

failures=0

quit_safari || exit 1
say ""

say "Removing:"
for target in "${SAFARI_COOKIES[@]}"; do
  remove_cookie_file "$target" || failures=$((failures + 1))
done

say ""
if (( failures > 0 )); then
  warn "Done with ${failures} failure(s). Fix the permission problem and run again."
  exit 1
fi

say "Done. Safari has no cookies left, so the next sign-in starts from scratch."
