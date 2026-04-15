/**
 * embed.ts
 *
 * Reads VNs from the local data.sqlite, calls Workers AI's bge-base-en-v1.5
 * via the Cloudflare REST API to embed `${title}\n${description}`, and writes
 * embeddings.ndjson in the format expected by `wrangler vectorize insert`:
 *
 *   {"id":"17","values":[...768 floats...],"metadata":{"title":"Steins;Gate"}}
 *
 * Env vars required:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN  (with Workers AI: Read perm)
 */

import { existsSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data.sqlite");
const OUT_PATH = path.join(ROOT, "embeddings.ndjson");

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const MODEL = "@cf/baai/bge-base-en-v1.5";
const BATCH_SIZE = 50;

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars.");
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  console.error(`Missing ${DB_PATH}. Run \`pnpm build-db\` first.`);
  process.exit(1);
}

/** Strip VNDB BBCode-ish formatting so the embedding focuses on prose. */
function stripFormatting(s: string): string {
  return s
    .replace(/\[url=[^\]]*\]/gi, "")
    .replace(/\[\/url\]/gi, "")
    .replace(/\[spoiler\]|\[\/spoiler\]/gi, "")
    .replace(/\[b\]|\[\/b\]|\[i\]|\[\/i\]/gi, "")
    .replace(/\[code\]|\[\/code\]/gi, "")
    .replace(/\[quote\][\s\S]*?\[\/quote\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: texts }),
  });
  if (!res.ok) {
    throw new Error(`Workers AI ${res.status}: ${await res.text()}`);
  }
  const json = await res.json() as { success: boolean; result: { data: number[][] }; errors?: unknown };
  if (!json.success) throw new Error(`Workers AI error: ${JSON.stringify(json.errors)}`);
  return json.result.data;
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare("SELECT id, title, description FROM vn ORDER BY id").all() as Array<{
    id: number;
    title: string;
    description: string | null;
  }>;
  console.log(`[embed] embedding ${rows.length} VNs in batches of ${BATCH_SIZE}`);

  const out = createWriteStream(OUT_PATH);
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const texts = batch.map((r) => {
      const desc = r.description ? stripFormatting(r.description).slice(0, 2000) : "";
      return `${r.title}\n${desc}`;
    });
    const vectors = await embedBatch(texts);
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j];
      out.write(JSON.stringify({
        id: String(r.id),
        values: vectors[j],
        metadata: { title: r.title },
      }) + "\n");
    }
    done += batch.length;
    process.stdout.write(`\r[embed] ${done}/${rows.length}`);
  }
  out.end();
  console.log(`\n[embed] wrote ${OUT_PATH}`);
  console.log(`[embed] next: wrangler vectorize insert vndb-vns --file=${path.basename(OUT_PATH)}`);
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
