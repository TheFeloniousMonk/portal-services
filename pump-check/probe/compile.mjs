// Compiles Probe.sol and writes the runtime bytecode and ABI into
// backend/probe-artifact.json. The image never compiles; it ships this file.
//
//   cd pump-check/probe && npm install && npm run build
//
// solc is pinned so the committed bytecode can be reproduced exactly.

import solc from "solc";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const source = readFileSync(new URL("./Probe.sol", import.meta.url), "utf8");
const input = {
  language: "Solidity",
  sources: { "Probe.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "cancun",
    outputSelection: { "*": { Probe: ["abi", "evm.deployedBytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

const c = out.contracts["Probe.sol"].Probe;
const runtime = "0x" + c.evm.deployedBytecode.object;
const artifact = {
  compiler: solc.version(),
  source_sha256: createHash("sha256").update(source).digest("hex"),
  runtime,
  abi: c.abi,
};
writeFileSync(new URL("../backend/probe-artifact.json", import.meta.url), JSON.stringify(artifact, null, 2) + "\n");
console.log(`runtime ${(runtime.length - 2) / 2} bytes, solc ${solc.version()}`);
