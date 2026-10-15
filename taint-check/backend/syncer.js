// The mirror sync: download each tracked ecosystem's all.zip from the OSV
// bucket, fold every record into a fresh index, and swap it in atomically. The
// bucket is public and unauthenticated; a sync spends no credits and hits no
// rate limit, so the only cost is bandwidth and the one-time parse.
//
// The index is rebuilt into a scratch instance and swapped only on success, so
// a failed or partial sync never replaces a good index with a broken one.

import { config } from "./config.js";
import { OsvIndex } from "./osv.js";
import { iterZipEntries } from "./unzip.js";

export const NOTE = Object.freeze({
  OK: "",
  UNREACHABLE: "unreachable",
  HTTP_ERROR: "http_error",
  BAD_ARCHIVE: "bad_archive",
  PARTIAL: "partial",
});

async function fetchEcosystem(scratch, ecosystem) {
  const url = config.osvBucketUrl + "/" + encodeURIComponent(ecosystem) + "/all.zip";
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": config.service + "/" + config.version },
      signal: AbortSignal.timeout(config.fetchDeadlineMs),
    });
  } catch {
    return { ok: false, note: NOTE.UNREACHABLE, records: 0 };
  }
  if (!res.ok) return { ok: false, note: NOTE.HTTP_ERROR, records: 0 };

  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch {
    return { ok: false, note: NOTE.UNREACHABLE, records: 0 };
  }

  let records = 0;
  try {
    for (const { name, data } of iterZipEntries(buf)) {
      if (!name.endsWith(".json")) continue;
      let rec;
      try {
        rec = JSON.parse(data.toString("utf8"));
      } catch {
        continue; // a single unparseable record must not fail the ecosystem
      }
      scratch.addRecord(rec);
      records++;
    }
  } catch {
    return { ok: false, note: NOTE.BAD_ARCHIVE, records };
  }
  return { ok: true, note: NOTE.OK, records };
}

export class Syncer {
  constructor(index) {
    this.index = index; // the live index the server reads from
    this.timer = null;
    this.running = false;
    this.stats = {
      ready: false,
      last_sync_at: null,
      last_sync_ok: false,
      note: NOTE.OK,
      ecosystems: {},
      records: 0,
      duration_ms: 0,
    };
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      this.sync().catch((err) => {
        console.error(JSON.stringify({ msg: "sync failed", error: String(err && err.message) }));
      });
    };
    if (config.syncOnStart) setTimeout(tick, config.syncOnStartDelayMs);
    this.timer = setInterval(tick, config.syncIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sync() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    const scratch = new OsvIndex(null, null); // build off to the side
    const perEco = {};
    let overall = NOTE.OK;
    let total = 0;

    try {
      for (const eco of config.ecosystems) {
        const r = await fetchEcosystem(scratch, eco);
        perEco[eco] = { ok: r.ok, records: r.records, note: r.note };
        total += r.records;
        if (!r.ok) overall = overall === NOTE.OK ? r.note : NOTE.PARTIAL;
      }

      // Only swap in a scratch index that actually holds records. An all-empty
      // build means every ecosystem failed; keep whatever we had before.
      if (total > 0) {
        scratch.asOf = new Date(startedAt).toISOString();
        this.index.loadSnapshot(scratch.toSnapshot());
        this.index.dir = config.dataDir;
        this.index.path = config.dataDir ? config.dataDir + "/" + config.snapshotName : null;
        await this.index.save().catch(() => {});
        this.stats.ready = true;
      } else {
        overall = NOTE.UNREACHABLE;
      }
    } finally {
      this.stats.last_sync_at = new Date(startedAt).toISOString();
      this.stats.last_sync_ok = overall === NOTE.OK && total > 0;
      this.stats.note = overall;
      this.stats.ecosystems = perEco;
      this.stats.records = this.index.size;
      this.stats.duration_ms = Date.now() - startedAt;
      this.running = false;
      console.log(
        JSON.stringify({
          msg: "sync",
          ok: this.stats.last_sync_ok,
          note: overall,
          records: total,
          keys: this.index.keys,
          duration_ms: this.stats.duration_ms,
        })
      );
    }
  }
}

// The live backstop for versions newer than the last snapshot. Off unless the
// operator enabled it; used only to enrich, never on the hot path by default.
export async function queryBatchApi(components) {
  const queries = components.map((c) => ({
    package: { ecosystem: c.ecosystem, name: c.name },
    version: String(c.version),
  }));
  try {
    const res = await fetch(config.osvApiUrl + "/v1/querybatch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": config.service + "/" + config.version },
      body: JSON.stringify({ queries }),
      signal: AbortSignal.timeout(config.fetchDeadlineMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
