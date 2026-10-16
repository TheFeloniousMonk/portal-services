#!/usr/bin/env bash
# Beta TestNet only. Run ON the supplier host. Sends relays for pump-check
# through the protocol with pocket-ap, signed by an application staked for
# pump-check.
#
# Key source, in order:
#   1. POCKET_APP_PRIVATE_KEY already in the environment (64 hex chars), e.g. the
#      app wallet exported from the Service Manager's Wallets tab;
#   2. $D/app-key.hex (mode 600, never committed) holding that hex.
# There is deliberately no keyring fallback: keys leave a keyring only through the
# Service Manager. The application must be staked for pump-check and the supplier
# must be in its current session, so wait one session after staking.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
SERVICE=pump-check
if [ -z "${POCKET_APP_PRIVATE_KEY:-}" ] && [ -s "$D/app-key.hex" ]; then
  POCKET_APP_PRIVATE_KEY=$(tr -d '[:space:]' < "$D/app-key.hex")
fi
if [ -z "${POCKET_APP_PRIVATE_KEY:-}" ]; then
  echo "no application key: export POCKET_APP_PRIVATE_KEY or write $D/app-key.hex (mode 600)" >&2
  exit 1
fi
export POCKET_APP_PRIVATE_KEY
AP="pocket-ap call --config $D/rendered/pocket-ap.yaml --service $SERVICE --rpc-type rest"

# Print the named fields of the last line of pocket-ap's output.
show() {
  python3 -c 'import sys,json
lines=sys.stdin.read().strip().splitlines()
t=lines[-1] if lines else ""
try:
    j=json.loads(t)
    if "results" in j:
        print(json.dumps([{k:r.get(k) for k in ("chain","verdict","found")} for r in j["results"]])[:400])
    else:
        print(json.dumps({k:j[k] for k in sys.argv[1:] if k in j})[:400])
except Exception:
    print("not JSON:", t[:300])' "$@"
}

echo "== GET /v1/version"
$AP -X GET --path /v1/version 2>&1 | show service version
echo "== POST /v1/check (the card's functional probe: USDC's freeze authority)"
$AP -X POST --path /v1/check --data '{"tokens":[{"chain":"solana","address":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}]}' 2>&1 | show
echo "== POST /v1/check (one token per chain)"
$AP -X POST --path /v1/check --data '{"tokens":[{"chain":"base","address":"0x4ef531e3dfbe63205e13b2b943630a53e6ac1c14"},{"chain":"robinhood","address":"0x94fc9ed527fc12d3c25229c44922e210f7e9fef0"}]}' 2>&1 | show
echo "== POST /v1/recent"
$AP -X POST --path /v1/recent --data '{"chain":"solana","limit":3}' 2>&1 | show
echo "== POST /v1/check (bad input must be a 4xx JSON error)"
$AP -X POST --path /v1/check --data '{"tokens":[{"chain":"base","address":"0x123"}]}' 2>&1 | show error
unset POCKET_APP_PRIVATE_KEY
