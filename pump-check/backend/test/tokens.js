// The tokens the recorded session covers, one per behaviour the tests assert.
export const TOKENS = [
  { chain: "solana", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", label: "USDC: known asset with live authorities" },
  { chain: "solana", address: "2FcRrTiT3i25mRb1emE9TA7jNj3VwLgUHi1pyo39pump", label: "Pump.fun token migrated to PumpSwap, LP burned" },
  { chain: "solana", address: "C3442L8JeNjUWuM3wqR65F8EY5RvGAwm9Cq5UsF5pump", label: "Pump.fun token still on its curve" },
  { chain: "base", address: "0x4ef531e3dfbe63205e13b2b943630a53e6ac1c14", label: "Uniswap v2 token, sellable, LP not burned" },
  { chain: "base", address: "0xd7da87d7dfe7524a72dc1b5930fc611836c39be2", label: "USDC-paired honeypot: sells revert" },
  { chain: "base", address: "0x90eb0e291e9d78a96bfe423b8e616a02c4838cf0", label: "owner not renounced" },
  { chain: "robinhood", address: "0xaed26758e1454cf9d2a0c103b3b3e54e425417b1", label: "Pons V2 token on its bonding curve" },
  { chain: "robinhood", address: "0x94fc9ed527fc12d3c25229c44922e210f7e9fef0", label: "Uniswap v4 token, hookless pool" },
  { chain: "robinhood", address: "0x5fc5a1f152a98ae93eb71cccf76ac0dc5f1ad168", label: "copycat USDG: owner can mint, blacklist or pause" },
];
