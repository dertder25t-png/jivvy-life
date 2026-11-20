#!/usr/bin/env bash
# Run the Electron self-test against a throwaway profile (never ~/.config/jivvy-life).
#   scripts/selftest.sh [all|quick|group,group,...]      (default: $JIVVY_SELFTEST or all)
# Builds first (npm run electron:build) unless JIVVY_SKIP_BUILD=1.
set -euo pipefail
cd "$(dirname "$0")/.."
spec="${1:-${JIVVY_SELFTEST:-all}}"
[ "$spec" = "0" ] && spec=all
if [ "${JIVVY_SKIP_BUILD:-}" != "1" ]; then npm run electron:build >/dev/null; fi
profile="$(mktemp -d -t jivvy-selftest-XXXXXX)"
case "$profile" in /tmp/*|"${TMPDIR:-/tmp}"/*) ;; *) echo "refusing odd profile dir: $profile" >&2; exit 2 ;; esac
trap 'rm -rf "$profile"' EXIT
set +e
JIVVY_SELFTEST="$spec" npx electron --ozone-platform-hint=auto --enable-features=WaylandWindowDecorations . --user-data-dir="$profile"
code=$?
set -e
exit $code
