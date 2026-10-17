// Suppliers staked for pump-check, for peer discovery: from the chain indexer
// (GraphQL), with the chain's REST API (LCD) as the fallback. The data a node
// keeps is about Base, Robinhood Chain and Solana, not about Pocket, so the
// suppliers of both Pocket networks are peers of each other.
//
// Unlike Meadow, every run is a complete listing: a service with a handful of
// suppliers does not need incremental reads.

import { REPLY_LIMITS, readJson } from "./read.js";

export const LCD = {
  main: "https://sauron-api.infra.pocket.network",
  beta: "https://sauron-api.beta.infra.pocket.network",
};

export const INDEXER = {
  main: "https://data.pocket.network/graphql",
  beta: "https://data.beta.pocket.network/graphql",
};

export const SERVICE_ID = "pump-check";
// An indexer this many blocks behind the chain it follows is not used.
export const INDEXER_MAX_LAG = 50;
const PAGING = { perPage: 100, maxPages: 20 };

// { suppliers: [{ operator, urls }], source, fallback? }
export async function listSuppliers(network, { serviceId = SERVICE_ID, indexer = INDEXER[network], base = LCD[network], fetch = globalThis.fetch, timeoutMs = 20000 } = {}) {
  let fallback = null;
  if (indexer) {
    try {
      return { suppliers: await indexerSuppliers({ url: indexer, serviceId, fetch, timeoutMs }), source: "indexer" };
    } catch (err) {
      fallback = err.message;
    }
  }
  const suppliers = await lcdSuppliers({ base, serviceId, fetch, timeoutMs });
  return { suppliers, source: "chain API", ...(fallback && { fallback }) };
}

export async function indexerSuppliers({ url, serviceId = SERVICE_ID, fetch = globalThis.fetch, timeoutMs = 20000 }) {
  const query = `query($service: String!, $first: Int!, $after: Cursor) {
    _metadata { lastProcessedHeight targetHeight }
    supplierServiceConfigs(filter: { serviceId: { equalTo: $service }, supplier: { stakeStatus: { equalTo: Staked } } }, first: $first, after: $after, orderBy: ID_ASC) {
      nodes { supplierId endpoints supplier { stakeStatus } } pageInfo { hasNextPage endCursor }
    }
  }`;
  const suppliers = [];
  let after = null;
  for (let page = 0; page < PAGING.maxPages; page++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { service: serviceId, first: PAGING.perPage, after } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await readJson(res, REPLY_LIMITS.lcdPage);
    if (!res.ok || (body && body.errors && body.errors.length) || !(body && body.data)) {
      throw new Error(`indexer: ${res.status}${body && body.errors && body.errors[0] ? " " + String(body.errors[0].message).slice(0, 120) : ""}`);
    }
    const data = body.data;
    if (page === 0) {
      const m = data._metadata || {};
      const processed = Number(m.lastProcessedHeight);
      if (!Number.isSafeInteger(processed)) throw new Error("indexer: no processed height");
      if (Number(m.targetHeight) - processed > INDEXER_MAX_LAG) throw new Error(`indexer: ${Number(m.targetHeight) - processed} blocks behind`);
    }
    const conn = data.supplierServiceConfigs || {};
    for (const n of conn.nodes || []) {
      if (typeof n.supplierId !== "string" || !(n.supplier && n.supplier.stakeStatus === "Staked")) continue;
      const urls = (Array.isArray(n.endpoints) ? n.endpoints : []).map((e) => e && e.url).filter((u) => typeof u === "string");
      if (urls.length) suppliers.push({ operator: n.supplierId, urls });
    }
    if (!(conn.pageInfo && conn.pageInfo.hasNextPage)) break;
    after = conn.pageInfo.endCursor;
  }
  return suppliers;
}

// Suppliers staked for the service and not unbonding, from the LCD.
export async function lcdSuppliers({ base, serviceId = SERVICE_ID, fetch = globalThis.fetch, timeoutMs = 20000 }) {
  if (!base) throw new Error("no chain API");
  const root = `${base.replace(/\/+$/, "")}/pokt-network/poktroll/supplier/supplier?service_id=${encodeURIComponent(serviceId)}&pagination.limit=50`;
  const suppliers = [];
  let key = null;
  for (let page = 0; page < PAGING.maxPages; page++) {
    const res = await fetch(key ? `${root}&pagination.key=${encodeURIComponent(key)}` : root, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`chain API: ${res.status}`);
    const body = await readJson(res, REPLY_LIMITS.lcdPage);
    for (const s of body.supplier || []) {
      if (Number(s.unstake_session_end_height || 0)) continue;
      const urls = (s.services || []).filter((x) => x.service_id === serviceId).flatMap((x) => (x.endpoints || []).map((e) => e.url));
      if (urls.length) suppliers.push({ operator: s.operator_address, urls });
    }
    key = body.pagination && body.pagination.next_key;
    if (!key) break;
  }
  return suppliers;
}
