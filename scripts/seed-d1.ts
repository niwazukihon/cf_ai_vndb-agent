/**
 * seed-d1.ts
 *
 * Reads data from data.sqlite and inserts it into the remote D1 database
 * using the Cloudflare D1 REST API with parameterized queries.
 * Parameterization means values are passed as JSON — no SQL-escaping needed,
 * and no issues with newlines, special characters, or expression depth limits.
 *
 * Usage (PowerShell):
 *   $env:CLOUDFLARE_ACCOUNT_ID="..."
 *   $env:CLOUDFLARE_API_TOKEN="..."   # needs D1: Edit permission
 *   $env:D1_DATABASE_ID="bb6d72a7-d661-42d1-9a58-839bb3de805e"
 *   pnpm seed-d1
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data.sqlite");
const SCHEMA_SQL = path.join(ROOT, "schema.sql");

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DB_ID = process.env.D1_DATABASE_ID;

if (!ACCOUNT_ID || !API_TOKEN || !DB_ID) {
  console.error(
    "Required env vars: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_ID\n" +
    "The D1_DATABASE_ID is the UUID in wrangler.toml (database_id field).\n" +
    "The API token needs 'D1: Edit' permission."
  );
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  console.error(`Missing ${DB_PATH}. Run \`pnpm build-db\` first.`);
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}`;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Execute a single SQL string (no params) — used for schema DDL. */
async function execRaw(sql: string, attempt = 1): Promise<void> {
  const res = await fetch(`${BASE}/raw`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params: [] }),
  });
  const json = await res.json() as { success: boolean; errors?: unknown[] };
  if (!json.success) {
    if (attempt < 3) { await sleep(1000 * attempt); return execRaw(sql, attempt + 1); }
    throw new Error(`D1 raw error: ${JSON.stringify(json.errors)}\nSQL: ${sql.slice(0, 300)}`);
  }
}

/** Execute a parameterized INSERT. Values are passed as JSON — no escaping needed. */
async function execQuery(sql: string, params: unknown[], attempt = 1): Promise<void> {
  const res = await fetch(`${BASE}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json() as { success: boolean; errors?: unknown[] };
  if (!json.success) {
    if (attempt < 3) { await sleep(1000 * attempt); return execQuery(sql, params, attempt + 1); }
    throw new Error(`D1 query error: ${JSON.stringify(json.errors)}\nSQL: ${sql.slice(0, 200)}`);
  }
}

/** Parse a SQL file into individual statements, stripping comment lines. */
function parseStatements(sql: string): string[] {
  const stripped = sql.replace(/^[ \t]*--[^\n]*/gm, "");
  return stripped
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Insert rows from SQLite into D1 using parameterized queries.
 * Sends `batchSize` rows per API call using a multi-row INSERT with
 * numbered placeholders (?1, ?2, ...).
 */
async function seedTable(
  sqlite: Database.Database,
  table: string,
  columns: string[],
): Promise<void> {
  // D1 caps parameterized queries at ?100 max. Compute safe batch size.
  const batchSize = Math.max(1, Math.floor(100 / columns.length));
  const rows = sqlite.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all() as Record<string, unknown>[];
  if (rows.length === 0) { console.log(`  ${table}: 0 rows, skipping`); return; }

  const colCount = columns.length;
  console.log(`  Seeding ${table}: ${rows.length} rows`);
  let done = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);

    // Build: INSERT INTO t (c1,c2,...) VALUES (?1,?2,...), (?N+1,?N+2,...), ...
    const valuePlaceholders = batch
      .map((_, ri) => `(${columns.map((_, ci) => `?${ri * colCount + ci + 1}`).join(",")})`)
      .join(",");
    const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${valuePlaceholders}`;
    const params = batch.flatMap((r) => columns.map((c) => r[c] ?? null));

    await execQuery(sql, params);
    done += batch.length;
    process.stdout.write(`\r    ${done}/${rows.length}`);
  }
  console.log(`\r    done (${rows.length} rows)             `);
}

async function main() {
  const sqlite = new Database(DB_PATH, { readonly: true });

  // 1. Load schema via raw endpoint (DDL has no user values, no newline risk).
  console.log("\n[seed-d1] Loading schema...");
  const schemaStatements = parseStatements(readFileSync(SCHEMA_SQL, "utf8"));
  console.log(`  ${schemaStatements.length} statements`);
  for (let i = 0; i < schemaStatements.length; i++) {
    await execRaw(schemaStatements[i]);
    process.stdout.write(`\r    ${i + 1}/${schemaStatements.length}`);
  }
  console.log(`\r    done                    `);

  // 2. Seed each table via parameterized queries — in dependency order.
  console.log("\n[seed-d1] Seeding tables...");
  await seedTable(sqlite, "tags",         ["id","name","cat","description"]);
  await seedTable(sqlite, "producers",    ["id","name","type","lang"]);
  await seedTable(sqlite, "vn",           ["id","title","latin","olang","released","length","rating","votecount","average","languages","platforms","description"]);
  await seedTable(sqlite, "tags_vn",      ["vid","tag","rating"]);
  await seedTable(sqlite, "vn_producers", ["vid","pid","developer","publisher"]);
  await seedTable(sqlite, "vn_relations", ["vid1","vid2","relation","official"]);

  // 3. Verify.
  console.log("\n[seed-d1] Verifying row counts...");
  for (const t of ["vn","tags","tags_vn","producers","vn_producers","vn_relations"]) {
    const res = await fetch(`${BASE}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: `SELECT COUNT(*) AS n FROM ${t}`, params: [] }),
    });
    const json = await res.json() as { result?: Array<{ results: Array<{ n: number }> }> };
    const n = json.result?.[0]?.results?.[0]?.n ?? "?";
    console.log(`  ${t}: ${n} rows`);
  }

  sqlite.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
