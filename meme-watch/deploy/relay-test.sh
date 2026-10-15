#!/usr/bin/env bash
# Beta TestNet only. Run ON the supplier host. Sends relays for meme-watch through
# the protocol with pocket-ap, signed by an application staked for meme-watch.
#
# Key source, in order:
#   1. POCKET_APP_PRIVATE_KEY already in the environment (64 hex chars), e.g. the
#      app wallet exported from the Service Manager's Wallets tab;
#   2. $D/app-key.hex (mode 600, never committed) holding that hex;
#   3. the throwaway "test-app" key from the first service's keyring, after
#      stake-test-app.sh re-pointed it at meme-watch.
# The application must be staked for meme-watch and the supplier must be in its
# current session, so wait one session after staking.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
APP_HOME="${APP_HOME:-/opt/pocket/services/jinx-service-builder-test/app-home}"
IMG=ghcr.io/pokt-network/pocketd:latest
SERVICE=meme-watch
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
echo "== POST /v1/launches (the card's functional probe)"
$AP -X POST --path /v1/launches --data '{"limit":1}' 2>&1 | tail -1 | python3 -c 'import sys,json
t=sys.stdin.read()
try:
    j=json.loads(t); rows=j.pop("launches",[]); print(json.dumps(j)); print("launches:", len(rows), rows[0].get("symbol") if rows else "")
except Exception:
    print("not JSON:", t[:300])'
echo "== POST /v1/launches (csv rides in a string field)"
$AP -X POST --path /v1/launches --data '{"format":"csv","limit":3}' 2>&1 | tail -1 | python3 -c 'import sys,json
t=sys.stdin.read()
try:
    j=json.loads(t); csv=j.pop("csv",""); print("format", j.get("format"), "count", j.get("count")); print("csv bytes", len(csv), "header:", csv.split("\n")[0][:80])
except Exception:
    print("not JSON:", t[:300])'
echo "== POST /v1/launches (bad input must be a 4xx JSON error)"
$AP -X POST --path /v1/launches --data '{"sort":"nope"}' 2>&1 | tail -1 | cut -c1-300
unset POCKET_APP_PRIVATE_KEY
