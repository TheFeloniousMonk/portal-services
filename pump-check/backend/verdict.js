// Verdict and flags (SPEC section 5).
//
// A verdict is built only from checks that ran. "unknown" on a critical check
// makes the verdict unknown unless something already failed; "not_available"
// (a check this service does not offer here) never does.

// Which check ids are critical when they fail, per chain. Everything else
// that fails or warns is a warning; "info" results are info.
const CRITICAL = {
  solana: new Set(["mint_authority", "freeze_authority", "token2022_extensions", "transfer_hook"]),
  evm: new Set(["honeypot", "sell_tax", "proxy", "privileged_functions"]),
};

// The checks whose "unknown" makes the verdict unknown.
const CRITICAL_MUST_RUN = {
  solana: ["mint_authority", "freeze_authority", "token2022_extensions", "transfer_hook"],
  evm: ["honeypot", "proxy", "privileged_functions"],
};

// One plain-language line per failing or warning check.
const REASONS = {
  mint_authority: "The mint authority can still create new supply.",
  freeze_authority: "The freeze authority can freeze any holder's tokens.",
  token2022_extensions: "Token-2022 extensions give someone control over transfers or balances.",
  transfer_hook: "A transfer hook program runs on every transfer and can block or tax it.",
  metadata_mutable: "The update authority can still change name, symbol and image.",
  launch_state: "Still on the launchpad's bonding curve.",
  creator_holding: "The creator still holds a large share of supply.",
  is_contract: "No contract at this address.",
  proxy: "The contract is upgradeable and its upgrade admin is not renounced.",
  owner: "The owner has not renounced control.",
  privileged_functions: "The owner can mint, blacklist or pause, and has not renounced.",
  honeypot: "A simulated buy could not be sold back.",
  buy_tax: "Buying is taxed.",
  sell_tax: "Selling is taxed.",
  lp_status: "Liquidity is neither burned nor locked, so it can be pulled.",
  liquidity: "Total liquidity is thin.",
  holder_concentration: "The top 10 holders own most of the supply.",
  deployer: "The deployer has launched many other tokens.",
  snipers_bundles: "Early buyers took a large share of supply.",
  age: "Less than an hour old.",
};

export function severityOf(chainKind, id, result) {
  if (result === "fail") return CRITICAL[chainKind].has(id) ? "critical" : "warning";
  if (result === "warn") return "warning";
  if (result === "info") return "info";
  return null;
}

export function buildVerdict(chain, checks, { knownAsset = false } = {}) {
  const kind = chain === "solana" ? "solana" : "evm";
  const flags = [];
  for (const [id, c] of Object.entries(checks)) {
    if (!c || !c.result) continue;
    let sev = severityOf(kind, id, c.result);
    if (!sev) continue;
    // A known asset keeps its authorities on purpose: reported, never alarming.
    if (knownAsset && sev !== "info") sev = "info";
    flags.push({ id, severity: sev, method: c.method || null, reason: c.reason || REASONS[id] || id, evidence: c.value ?? null });
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  flags.sort((a, b) => rank[a.severity] - rank[b.severity]);

  let verdict;
  if (knownAsset) verdict = "ok";
  else if (flags.some((f) => f.severity === "critical")) verdict = "danger";
  else if (CRITICAL_MUST_RUN[kind].some((id) => !checks[id] || checks[id].result === "unknown")) verdict = "unknown";
  else if (flags.some((f) => f.severity === "warning")) verdict = "caution";
  else verdict = "ok";
  return { verdict, flags };
}

// The full check list per chain, so every response has the same keys.
export const CHECK_IDS = {
  solana: [
    "mint_authority",
    "freeze_authority",
    "token2022_extensions",
    "transfer_hook",
    "metadata_mutable",
    "launch_state",
    "creator_holding",
    "lp_status",
    "liquidity",
    "holder_concentration",
    "snipers_bundles",
    "age",
  ],
  evm: [
    "is_contract",
    "proxy",
    "owner",
    "privileged_functions",
    "honeypot",
    "buy_tax",
    "sell_tax",
    "launch_state",
    "creator_holding",
    "lp_status",
    "liquidity",
    "holder_concentration",
    "deployer",
    "snipers_bundles",
    "age",
  ],
};

export const NOT_OFFERED = {
  solana: {
    holder_concentration: "not offered on Solana: no free source serves token holder lists reliably",
    snipers_bundles: "not offered on Solana: no free source serves launch transactions reliably",
  },
};
