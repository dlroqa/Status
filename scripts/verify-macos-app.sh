#!/usr/bin/env bash
#
# Verifies a packaged macOS bundle on a real Mac.
#
# v0.1.0 shipped a macOS build that could not launch at all, and nothing in the pipeline
# noticed: electron-builder skipped code signing, the build went green, and the failure only
# surfaced when someone tried to open the app. This script closes that gap by checking the
# things that actually decide whether a bundle runs.
#
# It is deliberately strict about the signature and about the app surviving launch, and
# deliberately lenient about Gatekeeper: an ad-hoc signed, un-notarised build is *expected*
# to be rejected by spctl, so that is reported rather than treated as a failure.

set -uo pipefail

readonly RELEASE_DIR="${1:-release}"
failures=0

fail() {
  printf '  FAIL: %s\n' "$1"
  failures=$((failures + 1))
}

pass() { printf '  ok  : %s\n' "$1"; }

verify_bundle() {
  local app="$1"
  printf '\n=== %s\n' "$app"

  # 1. Is the signature present, complete and internally consistent? --deep walks nested
  #    helpers and frameworks; --strict refuses the sloppier cases codesign would tolerate.
  if codesign --verify --deep --strict --verbose=2 "$app" 2>&1 | sed 's/^/      /'; then
    pass 'code signature is valid (deep, strict)'
  else
    fail 'code signature is invalid or absent'
  fi

  # 2. Which authority signed it. Ad-hoc shows no authority chain, which is expected here;
  #    what matters is that the field exists at all rather than the bundle being unsigned.
  local info
  info=$(codesign --display --verbose=4 "$app" 2>&1)
  if grep -q 'Signature=adhoc' <<<"$info"; then
    pass 'ad-hoc signature (expected without a Developer ID certificate)'
  elif grep -q 'Authority=' <<<"$info"; then
    pass "signed by: $(grep -m1 'Authority=' <<<"$info" | sed 's/^ *//')"
  else
    fail 'bundle carries no signature'
  fi

  # 3. The hardened runtime is enabled, so an ad-hoc signature *must* carry
  #    disable-library-validation or every bundled framework is refused at load time and
  #    the kernel kills the process. This is the exact entitlement whose absence would
  #    reproduce the original bug.
  local entitlements
  entitlements=$(codesign --display --entitlements :- "$app" 2>/dev/null)
  if grep -q 'com.apple.security.cs.disable-library-validation' <<<"$entitlements"; then
    pass 'disable-library-validation entitlement present'
  else
    fail 'disable-library-validation missing — ad-hoc + hardened runtime will not launch'
  fi
  if grep -q 'com.apple.security.cs.allow-jit' <<<"$entitlements"; then
    pass 'allow-jit entitlement present'
  else
    fail 'allow-jit missing — V8 cannot start'
  fi

  # 4. Gatekeeper's verdict. Informational: without notarisation this is always a rejection,
  #    and that is what the first-launch instructions in the README exist to handle.
  local assessment
  assessment=$(spctl --assess --type execute --verbose=4 "$app" 2>&1 || true)
  printf '      gatekeeper: %s\n' "$(tr '\n' ' ' <<<"$assessment" | sed 's/  */ /g')"

  # 5. The decisive check: does it actually stay up? A signature or library-validation
  #    failure kills the process immediately (SIGKILL), which is distinguishable from a
  #    clean start. Only the arch matching this runner can be executed.
  local exe
  exe="$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null)"
  if [[ ! -x "$exe" ]]; then
    fail "main executable not found or not executable: $exe"
    return
  fi

  local host_arch bundle_arch
  host_arch=$(uname -m)
  bundle_arch=$(lipo -archs "$exe" 2>/dev/null || echo unknown)
  if ! grep -qw "$host_arch" <<<"$bundle_arch"; then
    printf '      skipping launch: bundle is %s, runner is %s\n' "$bundle_arch" "$host_arch"
    return
  fi

  printf '      launching (%s)...\n' "$bundle_arch"
  local log_file status
  log_file=$(mktemp)
  "$exe" >"$log_file" 2>&1 &
  local pid=$!

  sleep 12

  if kill -0 "$pid" 2>/dev/null; then
    pass 'app launched and stayed running'
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
  else
    wait "$pid"
    status=$?
    # 137 = 128 + SIGKILL, which is what code-signing enforcement produces.
    if [[ $status -eq 137 ]]; then
      fail "app was killed on launch (exit 137) — signature enforcement rejected it"
    else
      fail "app exited early with status $status"
    fi
    printf '      --- output ---\n'
    sed 's/^/      /' "$log_file"
  fi
  rm -f "$log_file"
}

shopt -s nullglob
bundles=("$RELEASE_DIR"/mac*/*.app)
if [[ ${#bundles[@]} -eq 0 ]]; then
  echo "no .app bundles found under $RELEASE_DIR" >&2
  exit 1
fi

for bundle in "${bundles[@]}"; do
  verify_bundle "$bundle"
done

printf '\n'
if [[ $failures -gt 0 ]]; then
  printf '%d check(s) failed\n' "$failures"
  exit 1
fi
printf 'all macOS bundle checks passed\n'
