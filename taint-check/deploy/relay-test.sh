#!/usr/bin/env bash
# Beta TestNet only. Run ON the supplier host. Sends relays for taint-check through
# the protocol with pocket-ap, signed by an application staked for taint-check.
#
# Key source, in order:
#   1. POCKET_APP_PRIVATE_KEY already in the environment (64 hex chars), e.g. the
#      app wallet exported from the Service Manager's Wallets tab;
#   2. $D/app-key.hex (mode 600, never committed) holding that hex;
#   3. the throwaway "test-app" key from the first service's keyring, after
#      stake-test-app.sh re-pointed it at taint-check.
# The application must be staked for taint-check and the supplier must be in its
# current session, so wait one session after staking.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
APP_HOME="${APP_HOME:-/opt/pocket/services/jinx-service-builder-test/app-home}"
IMG=ghcr.io/pokt-network/pocketd:latest
SERVICE=taint-check
if [ -z "${POCKET_APP_PRIVATE_KEY:-}" ] && [ -s "$D/app-key.hex" ]; then
  POCKET_APP_PRIVATE_KEY=$(tr -d '[:space:]' < "$D/app-key.hex")
fi
if [ -z "${POCKET_APP_PRIVATE_KEY:-}" ]; then
  POCKET_APP_PRIVATE_KEY=$(printf 'y\n' | docker run --rm -i -v "$APP_HOME:/home" "$IMG" keys export test-app --unarmored-hex --unsafe --keyring-backend test --home /home 2>/dev/null | tr -d '\r\n')
fi
export POCKET_APP_PRIVATE_KEY
AP="pocket-ap call --config $D/rendered/pocket-ap.yaml --service $SERVICE --rpc-type rest"

echo "== GET /v1/version"
$AP -X GET --path /v1/version 2>&1 | tail -2
echo "== GET /v1/capabilities"
$AP -X GET --path /v1/capabilities 2>&1 | tail -1 | cut -c1-300
echo "== POST /v1/scan (the card's functional probe: minimist 1.2.0 -> vulnerable)"
$AP -X POST --path /v1/scan --data '{"components":[{"ecosystem":"npm","name":"minimist","version":"1.2.0"}],"options":{"heuristics":false}}' 2>&1 | tail -1 | python3 -c 'import sys,json
t=sys.stdin.read()
try:
    j=json.loads(t); f=(j.get("findings") or [{}])[0]
    print("data_as_of:", j.get("data_as_of"), "| verdict:", f.get("verdict"), "| top:", (f.get("vulnerabilities") or [{}])[0].get("id"))
except Exception:
    print("not JSON:", t[:300])'
echo "== POST /v1/scan (a small package-lock.json upload)"
$AP -X POST --path /v1/scan --data '{"lockfile":{"format":"package-lock.json","content":"{\"lockfileVersion\":3,\"packages\":{\"\":{},\"node_modules/minimist\":{\"version\":\"1.2.0\"}}}"}}' 2>&1 | tail -1 | python3 -c 'import sys,json
t=sys.stdin.read()
try:
    j=json.loads(t); s=j.get("summary",{}); print("format:", j.get("request",{}).get("format"), "| summary:", json.dumps(s))
except Exception:
    print("not JSON:", t[:300])'
echo "== POST /v1/scan (bad input must be a 4xx JSON error)"
$AP -X POST --path /v1/scan --data '{}' 2>&1 | tail -1 | cut -c1-300
unset POCKET_APP_PRIVATE_KEY
