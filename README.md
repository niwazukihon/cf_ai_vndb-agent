# cf_ai_vndb-agent

A Cloudflare-hosted chat agent that answers questions about visual novels using a curated subset of the [VNDB](https://vndb.org) database. Built for the Cloudflare AI internship assignment.

The agent supports:

- **Lookup** — "Tell me about Steins;Gate"
- **Filtered search** — "Best mystery VNs released after 2018"
- **Recommendations** — "VNs similar to Umineko"

## Components

| Requirement       | Implementation                                                              |
| ----------------- | --------------------------------------------------------------------------- |
| LLM               | Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` with tool calling   |
| Workflow / coord. | A Worker + a `ChatSession` Durable Object running the tool-calling loop    |
| User input        | Minimal responsive chat UI served as static assets, SSE responses           |
| Memory / state    | Durable Object stores chat history per session                              |

Plus:
- **D1** — SQLite holding the top ~10k VNs by vote count, their tags, producers, releases, and relations.
- **Vectorize** — 768-dim embeddings of `title + description` for semantic similarity search, generated with `@cf/baai/bge-base-en-v1.5`.

The agent decides which of five tools to call:

| Tool                  | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `search_vns_by_name`  | Title search against D1                                          |
| `filter_vns`          | Year / tag / language / rating / length filter against D1        |
| `get_vn_details`      | Full VN row + top tags + producers + related VNs                 |
| `similar_vns`         | Vectorize similarity search by id or free-text                   |
| `list_tags`           | Resolve a tag name like "mystery" to canonical tag ids           |

Everything fits in Cloudflare's free tier for personal / demo traffic.

## Repo layout

```
cf_ai_vndb-agent/
├── README.md
├── PROMPTS.md
├── wrangler.toml
├── schema.sql                 # D1 schema
├── package.json
├── tsconfig.json
├── scripts/
│   ├── build-db.ts            # parse VNDB dump → SQLite + data.sql
│   └── embed.ts               # generate Vectorize embeddings via Workers AI REST
├── src/
│   ├── index.ts               # Worker entry, /api/chat + /api/reset
│   ├── session.ts             # ChatSession Durable Object + agent loop
│   └── tools.ts               # tool defs and implementations
└── public/
    ├── index.html
    ├── chat.js
    └── styles.css
```

## Running it

### 0. Prereqs

- Node 20+
- `pnpm` (or `npm` — adapt the commands below)
- A Cloudflare account with Workers, D1, Vectorize, and Workers AI enabled (all available on the free plan)
- `wrangler` logged in: `npx wrangler login`
- The VNDB database dump extracted at `../vndb/vndb-db-YYYY-MM-DD/` (sibling of this folder). Grab the latest from <https://dl.vndb.org/dump/vndb-db-latest.tar.zst>.

### 1. Install deps

```bash
pnpm install
```

### 2. Build the D1 subset (offline)

```bash
pnpm build-db
```

This parses the VNDB COPY dump, picks the top 10,000 VNs by vote count, and writes `data.sqlite` (for verification) plus `data.sql` (batched INSERTs for D1). Adjust the size with `TOP_N=5000 pnpm build-db`.

Sanity-check the local SQLite:

```bash
sqlite3 data.sqlite "SELECT COUNT(*) FROM vn;"
sqlite3 data.sqlite "SELECT id, title, rating FROM vn WHERE id = 17;"  -- Steins;Gate
```

### 3. Create the Cloudflare resources

```bash
# D1
npx wrangler d1 create vndb
# → copy the printed database_id into wrangler.toml

# Vectorize (768 dims, cosine — match bge-base-en-v1.5)
npx wrangler vectorize create vndb-vns --dimensions=768 --metric=cosine
```

### 4. Push the schema and data into D1

```bash
npx wrangler d1 execute vndb --remote --file=./schema.sql
npx wrangler d1 execute vndb --remote --file=./data.sql
```

(For local dev against a local D1, swap `--remote` for `--local`.)

### 5. Generate and upload embeddings

```bash
export CLOUDFLARE_ACCOUNT_ID=...     # Workers > Account ID
export CLOUDFLARE_API_TOKEN=...      # token with "Workers AI: Read"
pnpm embed
npx wrangler vectorize insert vndb-vns --file=./embeddings.ndjson
```

### 6. Run locally

```bash
pnpm dev
```

Open <http://localhost:8787> and try:

- `Tell me about Steins;Gate`
- `Best mystery VNs released after 2018`
- `VNs similar to Umineko`

### 7. Deploy

```bash
pnpm deploy
```

Wrangler prints the public URL (something like `https://cf-ai-vndb-agent.<your-subdomain>.workers.dev`).

## Notes & limitations

- The dataset is the top ~10k VNs by vote count. Anything more obscure won't be in D1 / Vectorize, and the agent is instructed to admit that.
- Workers AI tool-calling response shape is still in flux; `src/session.ts` handles both the OpenAI-style `tool_calls` shape and the older flat shape.
- The "streaming" UI just emits one SSE chunk because Workers AI's tool-calling mode is non-streaming. Token-by-token streaming would require a non-tool-calling final pass.

## License

VNDB data is under ODbL + DbCL (see the original dump's README). Code in this repo is MIT.
