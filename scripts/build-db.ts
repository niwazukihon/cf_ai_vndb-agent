/**
 * build-db.ts
 *
 * Reads the VNDB PostgreSQL COPY dump from ../vndb/vndb-db-YYYY-MM-DD/db/
 * and produces:
 *   - data.sqlite : a local SQLite for testing
 *   - data.sql    : batched INSERT statements for `wrangler d1 execute --file=`
 *
 * Subset: top N VNs by c_votecount (default 10000), plus their tags, producers,
 * releases, and relations.
 */

import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DUMP_DIR = path.resolve(ROOT, "..", "vndb", "vndb-db-2026-04-14", "db");
const OUT_SQLITE = path.join(ROOT, "data.sqlite");
const OUT_DIR = path.join(ROOT, "data-sql");   // one .sql file per table
const SCHEMA_SQL = path.join(ROOT, "schema.sql");

const TOP_N = Number(process.env.TOP_N ?? 10000);

if (!existsSync(DUMP_DIR)) {
  console.error(`Dump dir not found: ${DUMP_DIR}`);
  process.exit(1);
}

// ---------- COPY format helpers ----------

/** Unescape a PG text-COPY field. \N (NULL) is handled by the caller. */
function unescape(s: string): string {
  if (s.indexOf("\\") === -1) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = s[++i];
    switch (next) {
      case "n": out += "\n"; break;
      case "r": out += "\r"; break;
      case "t": out += "\t"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "\\": out += "\\"; break;
      default:  out += next ?? ""; break;
    }
  }
  return out;
}

/** Parse one COPY line into an array of (string | null) fields. */
function parseLine(line: string): (string | null)[] {
  const raw = line.split("\t");
  return raw.map((f) => (f === "\\N" ? null : unescape(f)));
}

/** Strip the vndbid letter prefix ("v123" -> 123). */
function vid(s: string | null): number | null {
  if (s == null) return null;
  return Number(s.replace(/^[a-z]+/, ""));
}

async function readTable(name: string, onRow: (row: (string | null)[]) => void): Promise<void> {
  const headerPath = path.join(DUMP_DIR, `${name}.header`);
  const dataPath = path.join(DUMP_DIR, name);
  if (!existsSync(headerPath) || !existsSync(dataPath)) {
    throw new Error(`Missing table files for ${name}`);
  }
  const stream = createReadStream(dataPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    onRow(parseLine(line));
  }
}

function header(name: string): string[] {
  return readFileSync(path.join(DUMP_DIR, `${name}.header`), "utf8")
    .trim()
    .split("\t");
}

// ---------- Build pipeline ----------

type VnRow = {
  id: number;
  olang: string | null;
  c_votecount: number;
  c_rating: number;
  c_average: number;
  length: number | null;
  description: string | null;
};

async function main() {
  console.log(`[build-db] dump: ${DUMP_DIR}`);
  console.log(`[build-db] TOP_N=${TOP_N}`);

  // 1) Load all VNs, pick top N by votecount.
  const vnHeader = header("vn");
  const idxId = vnHeader.indexOf("id");
  const idxOlang = vnHeader.indexOf("olang");
  const idxVotes = vnHeader.indexOf("c_votecount");
  const idxRating = vnHeader.indexOf("c_rating");
  const idxAvg = vnHeader.indexOf("c_average");
  const idxLen = vnHeader.indexOf("length");
  const idxDesc = vnHeader.indexOf("description");

  const allVns: VnRow[] = [];
  await readTable("vn", (r) => {
    const id = vid(r[idxId]);
    if (id == null) return;
    allVns.push({
      id,
      olang: r[idxOlang],
      c_votecount: Number(r[idxVotes] ?? 0),
      c_rating: Number(r[idxRating] ?? 0) / 100,
      c_average: Number(r[idxAvg] ?? 0) / 100,
      length: r[idxLen] != null ? Number(r[idxLen]) : null,
      description: r[idxDesc],
    });
  });
  console.log(`[build-db] loaded ${allVns.length} VNs total`);

  allVns.sort((a, b) => b.c_votecount - a.c_votecount);
  const selected = allVns.slice(0, TOP_N);
  const selectedIds = new Set(selected.map((v) => v.id));
  console.log(`[build-db] selected top ${selected.length} VNs`);

  // 2) Pick a title for each selected VN from vn_titles.
  // Preference: english > original lang > first non-mtl > anything.
  const vtHeader = header("vn_titles");
  const vtIdx = {
    id: vtHeader.indexOf("id"),
    lang: vtHeader.indexOf("lang"),
    mtl: vtHeader.indexOf("mtl"),
    title: vtHeader.indexOf("title"),
    latin: vtHeader.indexOf("latin"),
  };
  const titles = new Map<number, { title: string; latin: string | null }>();
  const titleCandidates = new Map<number, Array<{ lang: string; mtl: boolean; title: string; latin: string | null }>>();
  await readTable("vn_titles", (r) => {
    const id = vid(r[vtIdx.id]);
    if (id == null || !selectedIds.has(id)) return;
    const entry = {
      lang: r[vtIdx.lang] ?? "",
      mtl: r[vtIdx.mtl] === "t",
      title: r[vtIdx.title] ?? "",
      latin: r[vtIdx.latin],
    };
    const list = titleCandidates.get(id);
    if (list) list.push(entry);
    else titleCandidates.set(id, [entry]);
  });

  const olangByVn = new Map(selected.map((v) => [v.id, v.olang ?? ""]));
  for (const [id, candidates] of titleCandidates) {
    const olang = olangByVn.get(id) ?? "";
    const score = (c: { lang: string; mtl: boolean }) => {
      let s = 0;
      if (c.lang === "en") s += 100;
      if (c.lang === olang) s += 50;
      if (!c.mtl) s += 10;
      return s;
    };
    candidates.sort((a, b) => score(b) - score(a));
    const best = candidates[0];
    titles.set(id, { title: best.title, latin: best.latin });
  }
  console.log(`[build-db] resolved titles for ${titles.size} VNs`);

  // 3) Releases: earliest date + lang/platform sets per VN.
  // First load releases base info.
  const rHeader = header("releases");
  const rIdx = {
    id: rHeader.indexOf("id"),
    released: rHeader.indexOf("released"),
    official: rHeader.indexOf("official"),
  };
  type Rel = { released: number | null; official: boolean };
  const releases = new Map<number, Rel>();
  await readTable("releases", (r) => {
    const id = vid(r[rIdx.id]);
    if (id == null) return;
    const released = r[rIdx.released] != null ? Number(r[rIdx.released]) : null;
    releases.set(id, { released, official: r[rIdx.official] === "t" });
  });

  // releases_vn -> link release to vn
  const rvHeader = header("releases_vn");
  const rvIdx = { id: rvHeader.indexOf("id"), vid: rvHeader.indexOf("vid") };
  const releasesByVn = new Map<number, number[]>();
  await readTable("releases_vn", (r) => {
    const rid = vid(r[rvIdx.id]);
    const v = vid(r[rvIdx.vid]);
    if (rid == null || v == null || !selectedIds.has(v)) return;
    const list = releasesByVn.get(v);
    if (list) list.push(rid);
    else releasesByVn.set(v, [rid]);
  });

  // releases_platforms
  const rpHeader = header("releases_platforms");
  const rpIdx = { id: rpHeader.indexOf("id"), platform: rpHeader.indexOf("platform") };
  const platformsByRelease = new Map<number, string[]>();
  await readTable("releases_platforms", (r) => {
    const rid = vid(r[rpIdx.id]);
    const plat = r[rpIdx.platform];
    if (rid == null || plat == null) return;
    const list = platformsByRelease.get(rid);
    if (list) list.push(plat);
    else platformsByRelease.set(rid, [plat]);
  });

  // releases_titles -> language is on each title row; we just want the languages set.
  const rtHeader = header("releases_titles");
  const rtIdx = { id: rtHeader.indexOf("id"), lang: rtHeader.indexOf("lang") };
  const langsByRelease = new Map<number, Set<string>>();
  await readTable("releases_titles", (r) => {
    const rid = vid(r[rtIdx.id]);
    const lang = r[rtIdx.lang];
    if (rid == null || !lang) return;
    let set = langsByRelease.get(rid);
    if (!set) { set = new Set(); langsByRelease.set(rid, set); }
    set.add(lang);
  });

  // Aggregate per-VN
  const vnRelease = new Map<number, { released: number | null; languages: string[]; platforms: string[] }>();
  for (const [v, rids] of releasesByVn) {
    let earliest: number | null = null;
    const langs = new Set<string>();
    const plats = new Set<string>();
    for (const rid of rids) {
      const rel = releases.get(rid);
      if (!rel) continue;
      if (rel.released != null && rel.released > 0) {
        if (earliest == null || rel.released < earliest) earliest = rel.released;
      }
      const ls = langsByRelease.get(rid);
      if (ls) for (const l of ls) langs.add(l);
      const ps = platformsByRelease.get(rid);
      if (ps) for (const p of ps) plats.add(p);
    }
    vnRelease.set(v, { released: earliest, languages: [...langs], platforms: [...plats] });
  }

  // 4) Tags (filter searchable+applicable).
  const tHeader = header("tags");
  const tIdx = {
    id: tHeader.indexOf("id"),
    cat: tHeader.indexOf("cat"),
    searchable: tHeader.indexOf("searchable"),
    applicable: tHeader.indexOf("applicable"),
    name: tHeader.indexOf("name"),
    description: tHeader.indexOf("description"),
  };
  const tags: Array<{ id: number; name: string; cat: string; description: string | null }> = [];
  await readTable("tags", (r) => {
    if (r[tIdx.searchable] !== "t" || r[tIdx.applicable] !== "t") return;
    const id = vid(r[tIdx.id]);
    if (id == null) return;
    tags.push({
      id,
      name: r[tIdx.name] ?? "",
      cat: r[tIdx.cat] ?? "",
      description: r[tIdx.description],
    });
  });
  console.log(`[build-db] kept ${tags.length} tags`);

  // 5) tags_vn — stream-aggregate per (vn,tag) for selected VNs.
  // Header: date tag vid uid vote spoiler ignore lie notes
  const tvHeader = header("tags_vn");
  const tvIdx = {
    tag: tvHeader.indexOf("tag"),
    vid: tvHeader.indexOf("vid"),
    vote: tvHeader.indexOf("vote"),
    ignore: tvHeader.indexOf("ignore"),
  };
  const tagAgg = new Map<string, { sum: number; n: number }>(); // key: `${vid}:${tag}`
  let tvLines = 0;
  await readTable("tags_vn", (r) => {
    tvLines++;
    if (r[tvIdx.ignore] === "t") return;
    const v = vid(r[tvIdx.vid]);
    if (v == null || !selectedIds.has(v)) return;
    const tag = vid(r[tvIdx.tag]);
    const vote = r[tvIdx.vote] != null ? Number(r[tvIdx.vote]) : 0;
    if (tag == null) return;
    const key = `${v}:${tag}`;
    const cur = tagAgg.get(key);
    if (cur) { cur.sum += vote; cur.n++; }
    else tagAgg.set(key, { sum: vote, n: 1 });
  });
  console.log(`[build-db] processed ${tvLines} tags_vn rows -> ${tagAgg.size} aggregates`);

  const tagsVn: Array<{ vid: number; tag: number; rating: number }> = [];
  for (const [key, { sum, n }] of tagAgg) {
    const rating = sum / n;
    if (rating <= 0) continue; // only positive consensus
    const [v, t] = key.split(":").map(Number);
    tagsVn.push({ vid: v, tag: t, rating });
  }
  console.log(`[build-db] kept ${tagsVn.length} positive (vn,tag) edges`);

  // 6) Producers via releases_producers + releases_vn.
  const rprHeader = header("releases_producers");
  const rprIdx = {
    id: rprHeader.indexOf("id"),
    pid: rprHeader.indexOf("pid"),
    developer: rprHeader.indexOf("developer"),
    publisher: rprHeader.indexOf("publisher"),
  };
  // map release -> [{pid, dev, pub}]
  const prodByRelease = new Map<number, Array<{ pid: number; dev: boolean; pub: boolean }>>();
  await readTable("releases_producers", (r) => {
    const rid = vid(r[rprIdx.id]);
    const pid = vid(r[rprIdx.pid]);
    if (rid == null || pid == null) return;
    const entry = { pid, dev: r[rprIdx.developer] === "t", pub: r[rprIdx.publisher] === "t" };
    const list = prodByRelease.get(rid);
    if (list) list.push(entry);
    else prodByRelease.set(rid, [entry]);
  });

  type VnProd = { vid: number; pid: number; developer: number; publisher: number };
  const vnProducersMap = new Map<string, VnProd>();
  for (const [v, rids] of releasesByVn) {
    for (const rid of rids) {
      const list = prodByRelease.get(rid);
      if (!list) continue;
      for (const e of list) {
        const key = `${v}:${e.pid}`;
        let cur = vnProducersMap.get(key);
        if (!cur) {
          cur = { vid: v, pid: e.pid, developer: 0, publisher: 0 };
          vnProducersMap.set(key, cur);
        }
        if (e.dev) cur.developer = 1;
        if (e.pub) cur.publisher = 1;
      }
    }
  }
  const usedProducerIds = new Set([...vnProducersMap.values()].map((x) => x.pid));
  console.log(`[build-db] vn_producers edges: ${vnProducersMap.size}, distinct producers: ${usedProducerIds.size}`);

  // 7) Producers — only those used.
  const pHeader = header("producers");
  const pIdx = {
    id: pHeader.indexOf("id"),
    type: pHeader.indexOf("type"),
    lang: pHeader.indexOf("lang"),
    name: pHeader.indexOf("name"),
    latin: pHeader.indexOf("latin"),
  };
  const producers: Array<{ id: number; name: string; type: string; lang: string }> = [];
  await readTable("producers", (r) => {
    const id = vid(r[pIdx.id]);
    if (id == null || !usedProducerIds.has(id)) return;
    // Prefer latin name when available, fall back to native.
    const name = (r[pIdx.latin] && r[pIdx.latin]!.length > 0 ? r[pIdx.latin]! : r[pIdx.name]) ?? "";
    producers.push({
      id,
      name,
      type: r[pIdx.type] ?? "",
      lang: r[pIdx.lang] ?? "",
    });
  });
  console.log(`[build-db] kept ${producers.length} producers`);

  // 8) vn_relations — only between selected VNs.
  const vrHeader = header("vn_relations");
  const vrIdx = {
    id: vrHeader.indexOf("id"),
    vid: vrHeader.indexOf("vid"),
    relation: vrHeader.indexOf("relation"),
    official: vrHeader.indexOf("official"),
  };
  const relations: Array<{ vid1: number; vid2: number; relation: string; official: number }> = [];
  await readTable("vn_relations", (r) => {
    const v1 = vid(r[vrIdx.id]);
    const v2 = vid(r[vrIdx.vid]);
    if (v1 == null || v2 == null) return;
    if (!selectedIds.has(v1) || !selectedIds.has(v2)) return;
    relations.push({
      vid1: v1,
      vid2: v2,
      relation: r[vrIdx.relation] ?? "",
      official: r[vrIdx.official] === "t" ? 1 : 0,
    });
  });
  console.log(`[build-db] kept ${relations.length} vn_relations`);

  // ---------- Write SQLite ----------
  if (existsSync(OUT_SQLITE)) {
    const fs = await import("node:fs/promises");
    await fs.unlink(OUT_SQLITE);
  }
  const db = new Database(OUT_SQLITE);
  db.exec(readFileSync(SCHEMA_SQL, "utf8"));

  const insertVn = db.prepare(`
    INSERT INTO vn (id, title, latin, olang, released, length, rating, votecount, average, languages, platforms, description)
    VALUES (@id, @title, @latin, @olang, @released, @length, @rating, @votecount, @average, @languages, @platforms, @description)
  `);
  const insertTag = db.prepare(`INSERT INTO tags (id, name, cat, description) VALUES (@id, @name, @cat, @description)`);
  const insertTagVn = db.prepare(`INSERT OR IGNORE INTO tags_vn (vid, tag, rating) VALUES (@vid, @tag, @rating)`);
  const insertProducer = db.prepare(`INSERT INTO producers (id, name, type, lang) VALUES (@id, @name, @type, @lang)`);
  const insertVnProd = db.prepare(`INSERT OR IGNORE INTO vn_producers (vid, pid, developer, publisher) VALUES (@vid, @pid, @developer, @publisher)`);
  const insertRel = db.prepare(`INSERT OR IGNORE INTO vn_relations (vid1, vid2, relation, official) VALUES (@vid1, @vid2, @relation, @official)`);

  const fmtDate = (n: number | null): string | null => {
    if (n == null || n <= 0) return null;
    const s = String(n).padStart(8, "0");
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  };

  const tx = db.transaction(() => {
    for (const v of selected) {
      const t = titles.get(v.id);
      if (!t) continue;
      const rel = vnRelease.get(v.id);
      insertVn.run({
        id: v.id,
        title: t.title,
        latin: t.latin,
        olang: v.olang,
        released: fmtDate(rel?.released ?? null),
        length: v.length,
        rating: v.c_rating,
        votecount: v.c_votecount,
        average: v.c_average,
        languages: rel ? JSON.stringify(rel.languages) : "[]",
        platforms: rel ? JSON.stringify(rel.platforms) : "[]",
        description: v.description,
      });
    }
    for (const t of tags) insertTag.run(t);
    for (const e of tagsVn) insertTagVn.run(e);
    for (const p of producers) insertProducer.run(p);
    for (const e of vnProducersMap.values()) insertVnProd.run(e);
    for (const r of relations) insertRel.run(r);
  });
  tx();
  console.log(`[build-db] wrote ${OUT_SQLITE}`);

  // ---------- Emit per-table SQL files for D1 ----------
  // One file per table so each `wrangler d1 execute --file=` call is small
  // enough to avoid D1's per-batch memory limit.
  mkdirSync(OUT_DIR, { recursive: true });

  const sqlEscape = (v: unknown): string => {
    if (v == null) return "NULL";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
    if (typeof v === "boolean") return v ? "1" : "0";
    // SQL string literals cannot contain raw newlines or carriage returns.
    // Replace them with CHAR() calls and concatenate the fragments.
    const s = String(v)
      .replace(/'/g, "''")
      .replace(/\r\n/g, "'||CHAR(13)||CHAR(10)||'")
      .replace(/\n/g, "'||CHAR(10)||'")
      .replace(/\r/g, "'||CHAR(13)||'");
    return `'${s}'`;
  };

  const MAX_STMT_BYTES = 80_000;
  function emitTable<T extends Record<string, unknown>>(
    table: string,
    columns: string[],
    rows: T[],
  ) {
    const outLines: string[] = [
      `-- ${table}: ${rows.length} rows. Generated by build-db.ts.`,
    ];
    const prefix = `INSERT INTO ${table} (${columns.join(",")}) VALUES\n`;
    let buf: string[] = [];
    let bytes = prefix.length;
    const flush = () => {
      if (buf.length === 0) return;
      outLines.push(prefix + buf.join(",\n") + ";");
      buf = [];
      bytes = prefix.length;
    };
    for (const r of rows) {
      const tuple = `(${columns.map((c) => sqlEscape(r[c])).join(",")})`;
      const add = tuple.length + 2;
      if (buf.length > 0 && bytes + add > MAX_STMT_BYTES) flush();
      buf.push(tuple);
      bytes += add;
    }
    flush();
    const outPath = path.join(OUT_DIR, `${table}.sql`);
    writeFileSync(outPath, outLines.join("\n") + "\n");
    console.log(`[build-db] wrote ${outPath} (${outLines.length - 1} statements)`);
  }

  // Build serialisable row arrays from the SQLite (so dates/JSON match what we wrote).
  const vnRows = db.prepare("SELECT * FROM vn").all() as Record<string, unknown>[];
  emitTable("vn", ["id","title","latin","olang","released","length","rating","votecount","average","languages","platforms","description"], vnRows);
  emitTable("tags", ["id","name","cat","description"], tags as unknown as Record<string, unknown>[]);
  emitTable("tags_vn", ["vid","tag","rating"], tagsVn as unknown as Record<string, unknown>[]);
  emitTable("producers", ["id","name","type","lang"], producers as unknown as Record<string, unknown>[]);
  emitTable("vn_producers", ["vid","pid","developer","publisher"], [...vnProducersMap.values()] as unknown as Record<string, unknown>[]);
  emitTable("vn_relations", ["vid1","vid2","relation","official"], relations as unknown as Record<string, unknown>[]);

  console.log(`[build-db] per-table SQL written to ${OUT_DIR}/`);

  db.close();
  console.log("[build-db] done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
