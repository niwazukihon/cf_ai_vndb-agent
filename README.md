# cf_ai_vndb-agent

A chat agent hosted on Cloudflare that answers questions about visual novels using a curated subset of the [VNDB](https://vndb.org) database, vibe coded.
A public instance is temporarily available [here](https://cf-ai-vndb-agent.arthniwa.workers.dev).

The agent supports:

- **Lookup** — "Tell me about Steins;Gate."
- **Filtered search** — "What are some good mystery visual novels released before 2020?"
- **Recommendations** — "Find visual novels similar to Umineko."

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

| Tool                  | Purpose                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `search_vns_by_name`  | Title search against D1                                                       |
| `filter_vns`          | Year / tag / language / rating / length filter; accepts `tag_names` directly  |
| `get_vn_details`      | Full VN row + top tags + producers + related VNs                              |
| `similar_vns`         | Vectorize similarity search by id or free-text                                |
| `list_tags`           | Resolve a tag name to canonical tag ids (rarely needed — `filter_vns` does it) |

The tool-calling loop in `ChatSession` also ships with several guardrails to cope with Llama 3.3's tool-use variance:

- **Duplicate-call hard-break** — if the model calls the same tool with the same arguments twice, the loop breaks instead of spinning.
- **Auto-recovery for hallucinated ids** — when `get_vn_details` returns "not found", the agent automatically runs `search_vns_by_name` with a cleaned version of the user's message and feeds the results back.
- **Turn-0 refusal recovery** — if the model outputs a refusal-like message on turn 0 without calling any tool, the agent injects a synthetic `search_vns_by_name` call and continues.
- **Forced final-answer pass** — if the loop exhausts `MAX_TURNS` without a text turn, one extra call is made with tools disabled to force a prose summary from the tool results already gathered.
- **Programmatic fallback** — if even that call produces no text, the most recent tool result is rendered as a markdown list so the user sees the actual data instead of an apology.

Everything fits in Cloudflare's free tier for personal / demo traffic.

## Repository layout

```
cf_ai_vndb-agent/
├── README.md
├── PROMPTS.md
├── wrangler.toml
├── schema.sql                 # D1 schema
├── package.json
├── tsconfig.json
├── scripts/
│   ├── build-db.ts            # parse VNDB dump → data.sqlite
│   ├── seed-d1.ts             # push schema + rows into remote D1 via REST API
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

## How to run

### Prerequisites

- Node 20+.
- `pnpm` (or `npm` — adapt the commands below).
- A Cloudflare account with Workers, D1, Vectorize, and Workers AI enabled (all available on the free plan).
- Cloudflare's `wrangler` logged in: `npx wrangler login`.
- The VNDB database dump extracted at `../vndb/vndb-db-YYYY-MM-DD/` (sibling of this folder). Grab the latest from <https://dl.vndb.org/dump/vndb-db-latest.tar.zst>.

### Install dependencies

```bash
pnpm install
```

### Build the D1 subset (offline)

```bash
pnpm build-db
```

This parses the VNDB COPY dump, picks the top 10,000 VNs by vote count, and writes `data.sqlite` locally. Adjust the size with `TOP_N=5000 pnpm build-db`.

Sanity-check the local SQLite:

```bash
sqlite3 data.sqlite "SELECT COUNT(*) FROM vn"
sqlite3 data.sqlite "SELECT id, title, rating FROM vn WHERE title LIKE '%Steins%Gate%'"
```

### Create the Cloudflare resources

```bash
# D1
npx wrangler d1 create vndb
# → copy the printed database_id into wrangler.toml

# Vectorize (768 dims, cosine — match bge-base-en-v1.5)
npx wrangler vectorize create vndb-vns --dimensions=768 --metric=cosine
```

### Push the schema and data into D1

`wrangler d1 execute --file=...` runs out of memory on the large inserts, so seeding is done via the D1 REST API using parameterised queries:

```bash
export CLOUDFLARE_ACCOUNT_ID=...     # Workers > Account ID
export CLOUDFLARE_API_TOKEN=...      # token with "D1: Edit"
export D1_DATABASE_ID=...            # the UUID from wrangler.toml
pnpm seed-d1
```

This loads `schema.sql` and then streams every row from `data.sqlite` into D1 in ≤100-parameter batches.

### Generate and upload embeddings

```bash
export CLOUDFLARE_API_TOKEN=...      # token needs "Workers AI: Read" + "Vectorize: Edit"
pnpm embed
npx wrangler vectorize insert vndb-vns --file=./embeddings.ndjson
```

### Run locally

```bash
pnpm dev
```

Open <http://localhost:8787> and try:

- `Tell me about Steins;Gate.`
- `What are some good mystery visual novels released before 2020?`
- `Find visual novels similar to Umineko.`

### Deploy

```bash
pnpm exec wrangler deploy
```

Wrangler prints the public URL (something like `https://cf-ai-vndb-agent.<your-subdomain>.workers.dev`).

## Notes & limitations

- The dataset is the top ~10k VNs by vote count. Anything more obscure won't be in D1 / Vectorize, and the agent is instructed to admit that.
- Workers AI tool-calling response shape is still in flux; `src/session.ts` handles both the OpenAI-style `tool_calls` shape and the older flat shape, and uses the flat format when sending tools to the model.
- The UI streams SSE events progressively as the agent runs: a `{type:"tool"}` event per tool call (rendered as a chip in the chat bubble) and a final `{type:"text"}` event with the answer. Token-by-token streaming of the final answer would require a separate non-tool-calling pass.
- Tool-calling quality on Llama 3.3 70B is uneven — it sometimes hallucinates VN ids or loops on the same tool. The guardrails listed above exist specifically to cope with that, rather than trusting the model to always self-correct.

## License

VNDB data is under ODbL + DbCL (see the data dump page [here](https://vndb.org/d14)). Code in this repo is MIT.
