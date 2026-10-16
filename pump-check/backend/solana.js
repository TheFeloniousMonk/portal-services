// Solana: addresses, account layouts, and the per-token checks (SPEC section 4).
//
// Layouts were read against live accounts on 2026-10-16:
//   Pump.fun bonding curve (program 6EF8...): 8-byte discriminator, then
//     virtual_token_reserves, virtual_sol_reserves, real_token_reserves,
//     real_sol_reserves, token_total_supply (u64 each), complete (bool),
//     creator (pubkey).
//   PumpSwap pool (program pAMM...): discriminator, bump u8, index u16, then
//     creator, base_mint, quote_mint, lp_mint, pool_base_token_account,
//     pool_quote_token_account (pubkeys), lp_supply u64, coin_creator.
//   Metaplex metadata: key u8, update_authority, mint, name, symbol, uri
//     (borsh strings), seller_fee u16, creators Option<Vec>, primary_sale bool,
//     is_mutable bool.
// Pump.fun mints are Token-2022 with the name and update authority in the
// mint's own tokenMetadata extension, so they need no Metaplex read.

import { sha256 } from "@noble/hashes/sha2";
import { ed25519 } from "@noble/curves/ed25519";
import { SOLANA } from "./chains.js";

// ---- base58 ---------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58].map((c, i) => [c, BigInt(i)]));

export function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const v = B58_MAP.get(c);
    if (v === undefined) throw new Error("not base58");
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

export function isSolanaAddress(s) {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    return b58decode(s).length === 32;
  } catch {
    return false;
  }
}

// ---- program-derived addresses ------------------------------------------------------

function onCurve(bytes) {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

export function findProgramAddress(seeds, programId) {
  const program = b58decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, PDA_MARKER];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const h = sha256(buf);
    if (!onCurve(h)) return b58encode(h);
  }
  throw new Error("no viable bump");
}

const utf8 = (s) => new TextEncoder().encode(s);
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export const pumpCurveAddress = (mint) => findProgramAddress([utf8("bonding-curve"), b58decode(mint)], SOLANA.pumpfunProgram);
export const metaplexAddress = (mint) =>
  findProgramAddress([utf8("metadata"), b58decode(SOLANA.metaplexProgram), b58decode(mint)], SOLANA.metaplexProgram);
export const associatedTokenAddress = (owner, mint, tokenProgram) =>
  findProgramAddress([b58decode(owner), b58decode(tokenProgram), b58decode(mint)], ATA_PROGRAM);

// ---- account layouts -------------------------------------------------------------

const pk = (buf, o) => b58encode(buf.subarray(o, o + 32));
const SYSTEM = "11111111111111111111111111111111";

export function parsePumpCurve(buf) {
  if (!buf || buf.length < 81) return null;
  return {
    virtualTokenReserves: buf.readBigUInt64LE(8),
    virtualSolReserves: buf.readBigUInt64LE(16),
    realTokenReserves: buf.readBigUInt64LE(24),
    realSolReserves: buf.readBigUInt64LE(32),
    tokenTotalSupply: buf.readBigUInt64LE(40),
    complete: buf[48] === 1,
    creator: pk(buf, 49),
  };
}

export function parsePumpSwapPool(buf) {
  if (!buf || buf.length < 211) return null;
  const coinCreator = buf.length >= 243 ? pk(buf, 211) : null;
  return {
    creator: pk(buf, 11),
    baseMint: pk(buf, 43),
    quoteMint: pk(buf, 75),
    lpMint: pk(buf, 107),
    baseVault: pk(buf, 139),
    quoteVault: pk(buf, 171),
    lpSupply: buf.readBigUInt64LE(203),
    coinCreator: coinCreator === SYSTEM ? null : coinCreator,
  };
}

export function parseMetaplex(buf) {
  if (!buf || buf.length < 70) return null;
  let o = 1;
  const updateAuthority = pk(buf, o);
  o += 64; // update authority and mint
  const str = () => {
    const len = buf.readUInt32LE(o);
    o += 4;
    const s = buf.subarray(o, o + len).toString("utf8").replace(/\0+$/, "");
    o += len;
    return s;
  };
  const name = str();
  const symbol = str();
  str(); // uri
  o += 2; // seller fee
  if (buf[o++] === 1) {
    const n = buf.readUInt32LE(o);
    o += 4 + n * 34;
  }
  o += 1; // primary sale happened
  return { updateAuthority, name, symbol, isMutable: buf[o] === 1 };
}

// ---- check helpers ------------------------------------------------------------------

const asOf = (slot) => ({ slot });
const live = (endpoint) => ({ source: "live", endpoint });

function check(result, fields) {
  return { result, ...fields };
}

// jsonParsed mint: {owner, data: {parsed: {info: {...}, type: "mint"}}}
export function readMint(acct) {
  if (!acct || !acct.data || !acct.data.parsed || acct.data.parsed.type !== "mint") return null;
  const info = acct.data.parsed.info;
  const ext = {};
  for (const e of info.extensions || []) ext[e.extension] = e.state ?? true;
  return {
    program: acct.owner,
    token2022: acct.owner === SOLANA.token2022Program,
    decimals: info.decimals,
    supply: BigInt(info.supply),
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    ext,
  };
}

// The authority and extension checks, from one jsonParsed read of the mint.
// These are the checks that decide whether a Solana token can be sold.
export function mintChecks(mint, slot, endpoint, { knownAsset = false, hookAllowlist = new Set() } = {}) {
  const base = { method: "definitive", ...live(endpoint), as_of: asOf(slot) };
  const out = {};
  out.mint_authority = check(mint.mintAuthority ? "fail" : "pass", { value: mint.mintAuthority, ...base });
  out.freeze_authority = check(mint.freezeAuthority ? "fail" : "pass", { value: mint.freezeAuthority, ...base });

  if (!mint.token2022) {
    out.token2022_extensions = check("not_applicable", { reason: "classic SPL token", method: null, source: null });
    out.transfer_hook = check("not_applicable", { reason: "classic SPL token", method: null, source: null });
    return out;
  }
  const e = mint.ext;
  const findings = [];
  let worst = "pass";
  const bump = (r) => {
    const rank = { pass: 0, warn: 1, fail: 2 };
    if (rank[r] > rank[worst]) worst = r;
  };
  const fee = e.transferFeeConfig;
  if (fee) {
    const bps = Number(fee.newerTransferFee?.transferFeeBasisPoints ?? fee.olderTransferFee?.transferFeeBasisPoints ?? 0);
    findings.push({ id: "transfer_fee", basis_points: bps, authority: fee.transferFeeConfigAuthority ?? null });
    if (bps > 0) bump(bps / 100 >= 25 ? "fail" : bps / 100 >= 5 ? "warn" : "pass");
    if (fee.transferFeeConfigAuthority) bump("warn");
  }
  if (e.permanentDelegate && e.permanentDelegate.delegate) {
    findings.push({ id: "permanent_delegate", delegate: e.permanentDelegate.delegate });
    bump("fail");
  }
  if (e.defaultAccountState && /frozen/i.test(String(e.defaultAccountState.accountState))) {
    findings.push({ id: "default_account_state_frozen" });
    bump("fail");
  }
  if (e.nonTransferable) {
    findings.push({ id: "non_transferable" });
    bump("fail");
  }
  if (e.pausableConfig) {
    findings.push({ id: "pausable", paused: e.pausableConfig.paused === true, authority: e.pausableConfig.authority ?? null });
    bump(e.pausableConfig.paused ? "fail" : e.pausableConfig.authority ? "fail" : "pass");
  }
  if (e.mintCloseAuthority && e.mintCloseAuthority.closeAuthority) {
    findings.push({ id: "mint_close_authority", authority: e.mintCloseAuthority.closeAuthority });
    bump("warn");
  }
  if (e.confidentialTransferMint) findings.push({ id: "confidential_transfers" });
  out.token2022_extensions = check(worst, {
    value: { extensions: Object.keys(e), findings },
    ...base,
  });

  const hook = e.transferHook && e.transferHook.programId;
  if (!hook) {
    out.transfer_hook = check("pass", { value: null, ...base });
  } else {
    // The hook's presence is definitive; whether its program is harmless is
    // only known for allowlisted programs.
    out.transfer_hook = check(hookAllowlist.has(hook) ? "pass" : "fail", {
      value: { program: hook, authority: e.transferHook.authority ?? null, recognized: hookAllowlist.has(hook) },
      reason: hookAllowlist.has(hook) ? null : "a transfer hook program runs on every transfer and can block or tax it",
      ...base,
    });
  }
  if (knownAsset) for (const k of Object.keys(out)) out[k].known_asset = true;
  return out;
}

// Metadata mutability: Token-2022 tokenMetadata extension first, then Metaplex.
export function metadataCheck(mint, metaplex, slot, endpoint) {
  const base = { method: "definitive", ...live(endpoint), as_of: asOf(slot) };
  const tm = mint.ext.tokenMetadata;
  if (tm) {
    const ua = tm.updateAuthority ?? null;
    return { check: check(ua ? "warn" : "pass", { value: { update_authority: ua, standard: "token2022_metadata" }, ...base }), name: tm.name, symbol: tm.symbol };
  }
  if (metaplex) {
    return {
      check: check(metaplex.isMutable ? "warn" : "pass", {
        value: { update_authority: metaplex.isMutable ? metaplex.updateAuthority : null, is_mutable: metaplex.isMutable, standard: "metaplex" },
        ...base,
      }),
      name: metaplex.name,
      symbol: metaplex.symbol,
    };
  }
  return { check: check("unknown", { reason: "no metadata account found", method: "definitive", source: "live", as_of: asOf(slot) }), name: null, symbol: null };
}

// Pump.fun launch state from the bonding-curve account.
export function launchStateCheck(curve, slot, endpoint) {
  const base = { method: "definitive", ...live(endpoint), as_of: asOf(slot) };
  if (!curve) return check("not_applicable", { reason: "not a Pump.fun launch", method: null, source: null });
  return check(curve.complete ? "pass" : "info", {
    value: {
      launchpad: "pumpfun",
      on_curve: !curve.complete,
      creator: curve.creator,
      real_sol_reserves: curve.realSolReserves.toString(),
      real_token_reserves: curve.realTokenReserves.toString(),
    },
    ...base,
  });
}

// PumpSwap LP: the pool records the LP supply it minted; the LP mint's current
// supply below that means the difference was burned. Pump.fun migrations burn
// all of it.
export function pumpSwapLp(pool, lpMintSupply) {
  if (lpMintSupply === null || pool.lpSupply === 0n) return { burnedPct: null };
  const burned = pool.lpSupply > lpMintSupply ? pool.lpSupply - lpMintSupply : 0n;
  return { burnedPct: Number((burned * 10000n) / pool.lpSupply) / 100 };
}

export const pct = (part, whole) => (whole > 0n ? Number((part * 10000n) / whole) / 100 : null);
