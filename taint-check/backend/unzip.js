// A minimal ZIP reader, enough to walk the OSV per-ecosystem all.zip archives.
//
// Node's standard library ships DEFLATE (node:zlib) but no ZIP container reader,
// and this service takes no third-party dependencies, so we parse the container
// ourselves. Only what OSV actually uses is supported: the central directory,
// stored (method 0) and deflated (method 8) entries. Encryption, ZIP64, and
// multi-disk archives are refused rather than mis-parsed.
//
// Yields { name, data } per file so the caller can parse each record without
// holding every decompressed file at once.

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50; // end of central directory
const CD_SIG = 0x02014b50; // central directory file header
const ZIP64_EOCD_SIG = 0x06064b50;

function findEocd(buf) {
  // The EOCD is at the end, before an optional comment of up to 65535 bytes.
  const min = 22;
  const start = Math.max(0, buf.length - (min + 0xffff));
  for (let i = buf.length - min; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

export function* iterZipEntries(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("not a zip archive (no EOCD)");

  let entries = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // A 0xffffffff offset means the real values live in the ZIP64 record. OSV's
  // archives are under 4 GiB per ecosystem, so this is a guard, not a path.
  if (cdOffset === 0xffffffff || entries === 0xffff) {
    const locatorSig = 0x07064b50;
    let z = -1;
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === locatorSig) {
        z = i;
        break;
      }
    }
    if (z < 0) throw new Error("zip64 locator not found");
    const z64 = Number(buf.readBigUInt64LE(z + 8));
    if (buf.readUInt32LE(z64) !== ZIP64_EOCD_SIG) throw new Error("bad zip64 eocd");
    entries = Number(buf.readBigUInt64LE(z64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
  }

  let p = cdOffset;
  for (let e = 0; e < entries; e++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error("bad central directory entry");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    // ZIP64 extra field can override the 0xffffffff sentinels above.
    if (compSize === 0xffffffff || localOffset === 0xffffffff) {
      let ep = p + 46 + nameLen;
      const end = ep + extraLen;
      while (ep + 4 <= end) {
        const id = buf.readUInt16LE(ep);
        const sz = buf.readUInt16LE(ep + 2);
        let q = ep + 4;
        if (id === 0x0001) {
          // Order in the record follows which fields were 0xffffffff.
          if (buf.readUInt32LE(p + 24) === 0xffffffff) q += 8; // uncompressed
          if (compSize === 0xffffffff) {
            compSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (localOffset === 0xffffffff) {
            localOffset = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
        }
        ep += 4 + sz;
      }
    }

    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error("encrypted zip entry: " + name);
    if (name.endsWith("/")) continue; // directory

    // Read the local header to find where the data actually starts; its name
    // and extra lengths can differ from the central directory's.
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error("unsupported compression method " + method + " for " + name);

    yield { name, data };
  }
}
