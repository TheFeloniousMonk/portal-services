// Reading a peer's or the chain API's reply with a size limit. `res.json()`
// buffers a body of any size, so a hostile peer could make this node hold as
// much as it can send before the timeout. This reads the stream and stops
// past the limit.

export const REPLY_LIMITS = {
  hello: 64 * 1024,
  // A holder snapshot of PUMP_PEER_MAX_HOLDERS rows fits well inside this.
  peer: 8 * 1024 * 1024,
  lcdPage: 8 * 1024 * 1024,
};

export class ReplyTooLarge extends Error {
  constructor(limit) {
    super(`reply over ${limit} bytes`);
    this.limit = limit;
  }
}

export async function readBytes(res, maxBytes) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel?.().catch(() => {});
    throw new ReplyTooLarge(maxBytes);
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new ReplyTooLarge(maxBytes);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ReplyTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function readJson(res, maxBytes) {
  return JSON.parse((await readBytes(res, maxBytes)).toString("utf8"));
}
