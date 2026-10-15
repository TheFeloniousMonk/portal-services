#!/usr/bin/env bash
# Beta TestNet only. Run ON the supplier host. Sends relays for infinifi through
# the protocol with pocket-ap, signed by an application staked for infinifi.
#
# Key source, in order:
#   1. POCKET_APP_PRIVATE_KEY already in the environment (64 hex chars), e.g. the
#      app wallet exported from the Service Manager's Wallets tab;
#   2. $D/app-key.hex (mode 600, never committed) holding that hex.
# There is deliberately no keyring fallback: keys leave a keyring only through the
# Service Manager. The application must be staked for infinifi and the supplier
# must be in its current session, so wait one session after staking.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
SERVICE=infinifi
# A public wallet with live infiniFi positions, used only as a read example.
WALLET="${WALLET:-0x46a83dc1a264bff133db887023d2884167094837}"
if [ -z "${POCKET_APP_PRIVATE_KEY:-}" ] && [ -s "$D/app-key.hex" ]; then
  POCKET_APP_PRIVATE_KEY=$(tr -d '[:space:]' < "$D/app-key.hex")
fi
if [ -z "${POCKET_APP_PRIVATE_KEY:-}" ]; then
  echo "no application key: export POCKET_APP_PRIVATE_KEY or write $D/app-key.hex (mode 600)" >&2
  exit 1
fi
export POCKET_APP_PRIVATE_KEY
AP="pocket-ap call --config $D/rendered/pocket-ap.yaml --service $SERVICE --rpc-type rest"

# Print the named top-level fields of the last line of pocket-ap's output.
show() {
  python3 -c 'import sys,json
lines=sys.stdin.read().strip().splitlines()
t=lines[-1] if lines else ""
try:
    j=json.loads(t); print(json.dumps({k:j[k] for k in sys.argv[1:] if k in j})[:400])
except Exception:
    print("not JSON:", t[:300])' "$@"
}

echo "== GET /v1/version"
$AP -X GET --path /v1/version 2>&1 | show service version
echo "== POST /v1/yields (the card's functional probe: staked.token = siUSD)"
$AP -X POST --path /v1/yields --data '{}' 2>&1 | show staked fetched_at stale
echo "== POST /v1/overview"
$AP -X POST --path /v1/overview --data '{}' 2>&1 | show asset lock_tiers
echo "== POST /v1/farms (illiquid, by APY)"
$AP -X POST --path /v1/farms --data '{"type":"illiquid","sort":"apy"}' 2>&1 | show count
echo "== POST /v1/allocation-votes (current epoch)"
$AP -X POST --path /v1/allocation-votes --data '{}' 2>&1 | show epoch
echo "== POST /v1/wallet"
$AP -X POST --path /v1/wallet --data "{\"address\":\"$WALLET\"}" 2>&1 | show value_usd pnl_iusd missing
echo "== POST /v1/wallet (bad input must be a 4xx JSON error)"
$AP -X POST --path /v1/wallet --data '{"address":"0x123"}' 2>&1 | show error
unset POCKET_APP_PRIVATE_KEY
