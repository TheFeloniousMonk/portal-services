// Addresses PumpCheck relies on, per chain. Every entry was read on chain
// through Pocket's public RPC or taken from the publisher's own deployment
// list on 2026-10-16 (see the service README for sources). Addresses are
// lowercase; comparisons are on lowercase.

const lower = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? v.toLowerCase() : v]));

export const ZERO = "0x0000000000000000000000000000000000000000";

// ---- Solana -------------------------------------------------------------------

export const SOLANA = Object.freeze({
  wsol: "So11111111111111111111111111111111111111112",
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022Program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  metaplexProgram: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  pumpfunProgram: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  pumpswapProgram: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  // Quote assets: the other side of a memecoin's pool.
  quotes: new Set([
    "So11111111111111111111111111111111111111112", // wSOL
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", // USD1
  ]),
  // Majors and stablecoins that legitimately keep mint and freeze authorities.
  knownAssets: new Map([
    ["So11111111111111111111111111111111111111112", "wSOL"],
    ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"],
    ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT"],
    ["USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", "USD1"],
    ["2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "PYUSD"],
    ["mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", "mSOL"],
    ["J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", "JitoSOL"],
    ["cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", "cbBTC"],
  ]),
});

// DexPaprika dex ids that are launchpads rather than open markets.
export const SOLANA_LAUNCHPAD_DEXES = new Map([
  ["pumpfun", "pumpfun"],
  ["meteora_dbc", "meteora_dbc"],
  ["raydium_launchlab", "raydium_launchlab"],
]);

// ---- EVM ------------------------------------------------------------------------

const BASE = {
  chainId: 8453,
  weth: "0x4200000000000000000000000000000000000006",
  // From Uniswap's deployments.json (generated 2026-09-22).
  uniV2Factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
  uniV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  uniV4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
  uniV4PositionManager: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
  uniV4StateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
};

// DexPaprika dex ids mapped to the probe's pool interface. Aerodrome has
// several factories per pool type, so pools are recognized by DexPaprika's
// label rather than a factory list.
//
// Only venues whose swap math and callback the probe implements exactly are
// listed. A v2 fork with a fee above 0.3% would fail the probe's swap, and
// PancakeSwap v3 calls a differently named callback, so neither is here; a
// token whose only pools are elsewhere gets honeypot "unknown".
export const EVM_DEX_KIND = new Map([
  ["uniswap_v2", "univ2"],
  ["sushiswap", "univ2"],
  ["uniswap_v3", "univ3"],
  ["sushiswap_v3", "univ3"],
  ["alien_base_v3", "univ3"],
  ["baseswap_v3", "univ3"],
  ["uniswap_v4", "univ4"],
  ["aerodrome", "solidly"],
  ["aerodrome_v3", "univ3"],
  ["aerodrome_slipstream_2", "univ3"],
  ["aerodrome_slipstream_3", "univ3"],
  ["pons_curve", "pons_curve"],
]);

const ROBINHOOD = {
  chainId: 4663,
  weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  uniV2Factory: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f",
  uniV3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  uniV4PoolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  uniV4PositionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
  uniV4StateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
  ponsV2Factory: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
  ponsV2Hook: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
  ponsV2Locker: "0x267444d099b10fb5ed7c3cc7b7c767adca574952",
  ponsV1Factory: "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb",
};

export const EVM = Object.freeze({ base: lower(BASE), robinhood: lower(ROBINHOOD) });

// Quote assets per chain: the side of a pool that is not the memecoin.
export const EVM_QUOTES = Object.freeze({
  base: new Set(
    [
      ZERO,
      "0x4200000000000000000000000000000000000006", // WETH
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
      "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
      "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI
      "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", // USDT
      "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", // cbBTC
      "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", // cbETH
      "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452", // wstETH
      "0x1111111111166b7fe7bd91427724b487980afc69", // ZORA (pairs every Zora coin)
    ].map((a) => a.toLowerCase())
  ),
  robinhood: new Set([ZERO, ROBINHOOD.weth]),
});

// Majors, stablecoins and issuer-controlled assets (tokenized stocks) that
// legitimately keep an owner, mint or pause. Symbols were read on chain.
export const EVM_KNOWN_ASSETS = Object.freeze({
  base: new Map([
    ["0x4200000000000000000000000000000000000006", "WETH"],
    ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "USDC"],
    ["0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", "USDbC"],
    ["0x50c5725949a6f0c72e6c4a641f24049a917db0cb", "DAI"],
    ["0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", "USDT"],
    ["0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", "cbBTC"],
    ["0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", "cbETH"],
    ["0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452", "wstETH"],
  ]),
  // WETH, USDG and cbBTC, plus the tokenized stocks the Pons V2 factory
  // approves as pair tokens (approvedPairTokens read on chain 2026-10-16).
  robinhood: new Map(
    Object.entries({
      "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "WETH",
      "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG",
      "0xcec185eb182c47d1ba1efc84e6959e18cd620be4": "cbBTC",
      "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9": "AAPL",
      "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc": "AMD",
      "0x12f190a9f9d7d37a250758b26824b97ce941bf54": "AMZN",
      "0x48e39e56acdba37b09020c0b734a613c9a2f100a": "BB",
      "0x6330d8c3178a418788df01a47479c0ce7ccf450b": "COIN",
      "0x4ea005168d7f09a7a0ba9d1def21a479950e44c2": "COST",
      "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5": "CRCL",
      "0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd": "DELL",
      "0x1d11f0496982706c5e14a514d4e79f2e6bde4516": "DJT",
      "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e": "GLD",
      "0x1b0e319c6a659f002271b69db8a7df2f911c153e": "GME",
      "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3": "GOOGL",
      "0xccee82fe024c36fa15e1005ede3e9e4787e23d09": "HIMS",
      "0x8005d266423c7ea827372c9c864491e5786600ea": "LLY",
      "0xc0d6457c16cc70d6790dd43521c899c87ce02f35": "META",
      "0xe93237c50d904957cf27e7b1133b510c669c2e74": "MSFT",
      "0xec262a75e413fafd0df80480274532c79d42da09": "MSTR",
      "0xff080c8ce2e5feadaca0da81314ae59d232d4afd": "MU",
      "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": "NVDA",
      "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a": "PLTR",
      "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68": "QQQ",
      "0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8": "RBLX",
      "0x05b37fb53a299a1b874a619e1c4c404d52c36f4c": "RDDT",
      "0x84cab63bc87912e71ad199ff14a0ba45de68fef8": "SKHY",
      "0xb90a19ff0af67f7779aff50a882a9cff42446400": "SNDK",
      "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea": "SPCX",
      "0x117cc2133c37b721f49de2a7a74833232b3b4c0c": "SPY",
      "0x322f0929c4625ed5bad873c95208d54e1c003b2d": "TSLA",
      "0x58ffe4a942d3885baa22d7520691f611ef09e7aa": "TSM",
      "0x5e81213613b6b86eab4c6c50d718d34359459786": "TTWO",
      "0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344": "USO",
      "0x9e7abd3c9139d14e4c86dce0e455aab7a0c2fb3e": "WYFI",
    })
  ),
});

// Every known asset is also a quote asset.
for (const chain of ["base", "robinhood"]) for (const a of EVM_KNOWN_ASSETS[chain].keys()) EVM_QUOTES[chain].add(a);

// Launchpad factories, keyed by the address that creates the token (the
// creator Blockscout reports). Pons is also recognized on chain without
// Blockscout, through its factory's getLaunchedToken.
export const EVM_LAUNCHPADS = Object.freeze({
  base: new Map(
    Object.entries({
      "0xe85a59c628f7d27878aceb4bf3b35733630083a9": "clanker",
      "0x2a787b2362021cc3eea3c24c4748a6cd5b687382": "clanker",
      "0x375c15db32d28cecdcab5c03ab889bf15cbd2c5e": "clanker",
      "0x732560fa1d1a76350b1a500155ba978031b53833": "clanker",
      "0x9b84fce5dcd9a38d2d01d5d72373f6b6b067c3e1": "clanker",
      "0x777777751622c0d3258f214f9df38e35bf45baf3": "zora",
    })
  ),
  robinhood: new Map(
    Object.entries({
      "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e": "pons",
      "0x3711cea4feade896c913c68f01eda97cb06d1a42": "pons",
      "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb": "pons_v1",
      "0x0c37a24f5d23a486fa692d1500881d698b1f77a4": "pons_v1",
      "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0": "uniswap_launchpad",
      "0x00004c4ccc709ef590f7c81102c0689f0263d4e9": "uniswap_launchpad",
    })
  ),
});

// Launchpads that lock the pool's liquidity permanently by design, and the
// contracts that hold those locked positions.
export const LOCKING_LAUNCHPADS = new Set(["clanker", "pons", "zora"]);
export const EVM_LP_LOCKERS = Object.freeze({
  base: new Map(
    Object.entries({
      "0x29d17c1a8d851d7d4ca97fae97acadb398d9cce0": "clanker_lp_locker_v4",
      "0x63d2dfea64b3433f4071a98665bcd7ca14d93496": "clanker_lp_locker_v4_fee_conversion",
      "0x33e2eda238edcf470309b8c6d228986a1204c8f9": "clanker_lp_locker_v3_1",
      "0x5ec4f99f342038c67a312a166ff56e6d70383d86": "clanker_lp_locker_v3",
      "0x618a9840691334ee8d24445a4ada4284bf42417d": "clanker_lp_locker_v2",
    })
  ),
  robinhood: new Map(Object.entries({ "0x267444d099b10fb5ed7c3cc7b7c767adca574952": "pons_v2_launch_locker" })),
});

// v4 hooks known to belong to a launchpad. A hook can take a fee or block a
// swap; one listed here is a launchpad's published hook, and the probe still
// measures what it takes.
export const EVM_KNOWN_HOOKS = Object.freeze({
  base: new Map(
    Object.entries({
      "0xd60d6b218116cfd801e28f78d011a203d2b068cc": "clanker_dynamic_fee_v2",
      "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc": "clanker_static_fee_v2",
      "0x34a45c6b61876d739400bd71228cbcbd4f53e8cc": "clanker_dynamic_fee",
      "0xdd5eeaff7bd481ad55db083062b13a3cdf0a68cc": "clanker_static_fee",
    })
  ),
  robinhood: new Map(Object.entries({ "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044": "pons_v2_meme_hook" })),
});

export const BURN_ADDRESSES = new Set([
  ZERO,
  "0x000000000000000000000000000000000000dead",
  "0xdead000000000000000042069420694206942069",
]);
