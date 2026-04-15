import type { Env } from "./index";

/**
 * Tool definitions exposed to the LLM, plus their TypeScript implementations.
 *
 * Each tool returns a small JSON-serialisable object that gets fed back to the
 * model as a `tool` message. Results are kept terse (limit columns, cap row
 * counts) so we don't blow the context window.
 */

// Cloudflare Workers AI uses a flat tool format (no "type":"function" wrapper).
export const TOOL_SPECS = [
  {
    name: "search_vns_by_name",
    description: "Search visual novels by (partial) title. Returns up to `limit` matches with id, title, year, and rating. Use this when the user names a specific VN.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Title or partial title to search for" },
        limit: { type: "integer", description: "Max results (default 8)" },
      },
      required: ["query"],
    },
  },
  {
    name: "filter_vns",
    description: "Filter visual novels by year, tags, language, length, and minimum rating. Use this for queries like 'best mystery VNs released after 2018'. Tag names must come from list_tags first.",
    parameters: {
      type: "object",
      properties: {
        year_min: { type: "integer" },
        year_max: { type: "integer" },
        tag_ids: { type: "array", items: { type: "integer" }, description: "IDs from list_tags. All listed tags must apply (AND)." },
        min_rating: { type: "number", description: "Minimum rating on a 0-10 scale, e.g. 8.0" },
        min_votes: { type: "integer" },
        language: { type: "string", description: "Two-letter language code, e.g. 'en'" },
        length: { type: "integer", description: "1=very short .. 5=very long" },
        order_by: { type: "string", enum: ["rating", "votecount", "released"] },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "get_vn_details",
    description: "Get full details for a single visual novel by id: description, top tags, developers/publishers, related VNs.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer", description: "Numeric VN id (the digits of v123)" } },
      required: ["id"],
    },
  },
  {
    name: "similar_vns",
    description: "Find visual novels semantically similar to the given VN (by id) or to a free-text description. Use this for 'similar to X' or 'I want a VN about Y' queries.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "integer", description: "VN id to find neighbours of" },
        text: { type: "string", description: "Free-text description to match against (alternative to id)" },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "list_tags",
    description: "Look up tag ids by (partial) name. Use this BEFORE filter_vns whenever you need tag ids. Returns up to 10 candidates.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
] as const;

type ToolArgs = Record<string, unknown>;

export async function runTool(env: Env, name: string, args: ToolArgs): Promise<unknown> {
  switch (name) {
    case "search_vns_by_name": return searchVnsByName(env, args);
    case "filter_vns":         return filterVns(env, args);
    case "get_vn_details":     return getVnDetails(env, args);
    case "similar_vns":        return similarVns(env, args);
    case "list_tags":          return listTags(env, args);
    default: return { error: `unknown tool: ${name}` };
  }
}

// ---------- implementations ----------

async function searchVnsByName(env: Env, args: ToolArgs) {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query required" };
  const limit = clampInt(args.limit, 1, 20, 8);
  const like = `%${query}%`;
  const { results } = await env.DB.prepare(
    `SELECT id, title, latin, substr(released, 1, 4) AS year, rating, votecount
     FROM vn
     WHERE title LIKE ?1 OR latin LIKE ?1
     ORDER BY votecount DESC
     LIMIT ?2`,
  ).bind(like, limit).all();
  return { results };
}

async function filterVns(env: Env, args: ToolArgs) {
  const limit = clampInt(args.limit, 1, 25, 10);
  const orderByRaw = String(args.order_by ?? "rating");
  const orderBy = (["rating", "votecount", "released"] as const).includes(orderByRaw as any) ? orderByRaw : "rating";
  const tagIds = Array.isArray(args.tag_ids) ? (args.tag_ids as unknown[]).map(Number).filter(Number.isFinite) : [];

  const where: string[] = [];
  const binds: unknown[] = [];
  const push = (clause: string, ...vals: unknown[]) => { where.push(clause); binds.push(...vals); };

  if (args.year_min != null) push("substr(released,1,4) >= ?", String(args.year_min));
  if (args.year_max != null) push("substr(released,1,4) <= ?", String(args.year_max));
  if (args.min_rating != null) push("rating >= ?", Number(args.min_rating));
  if (args.min_votes != null) push("votecount >= ?", Number(args.min_votes));
  if (args.length != null) push("length = ?", Number(args.length));
  if (args.language) push("languages LIKE ?", `%"${String(args.language)}"%`);

  let sql = `SELECT id, title, substr(released,1,4) AS year, rating, votecount FROM vn`;
  if (tagIds.length > 0) {
    // Require ALL listed tags via INTERSECT-style HAVING count.
    const placeholders = tagIds.map(() => "?").join(",");
    sql = `SELECT v.id, v.title, substr(v.released,1,4) AS year, v.rating, v.votecount
           FROM vn v
           JOIN tags_vn tv ON tv.vid = v.id
           WHERE tv.tag IN (${placeholders})`;
    binds.unshift(...tagIds);
    if (where.length) sql += " AND " + where.join(" AND ");
    sql += ` GROUP BY v.id HAVING COUNT(DISTINCT tv.tag) = ${tagIds.length}`;
  } else if (where.length) {
    sql += " WHERE " + where.join(" AND ");
  }
  sql += ` ORDER BY ${orderBy} DESC LIMIT ?`;
  binds.push(limit);

  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return { results, sql };
}

async function getVnDetails(env: Env, args: ToolArgs) {
  const id = Number(args.id);
  if (!Number.isFinite(id)) return { error: "id required" };
  const vn = await env.DB.prepare(
    `SELECT id, title, latin, olang, released, length, rating, votecount, average, languages, platforms, description
     FROM vn WHERE id = ?`,
  ).bind(id).first();
  if (!vn) return { error: `v${id} not found in dataset. Call search_vns_by_name first to get the correct id.` };

  const { results: tagRows } = await env.DB.prepare(
    `SELECT t.id, t.name, t.cat, tv.rating
     FROM tags_vn tv JOIN tags t ON t.id = tv.tag
     WHERE tv.vid = ? ORDER BY tv.rating DESC LIMIT 12`,
  ).bind(id).all();

  const { results: prodRows } = await env.DB.prepare(
    `SELECT p.id, p.name, vp.developer, vp.publisher
     FROM vn_producers vp JOIN producers p ON p.id = vp.pid
     WHERE vp.vid = ? LIMIT 8`,
  ).bind(id).all();

  const { results: relRows } = await env.DB.prepare(
    `SELECT r.vid2 AS id, v.title, r.relation
     FROM vn_relations r JOIN vn v ON v.id = r.vid2
     WHERE r.vid1 = ? LIMIT 10`,
  ).bind(id).all();

  // Trim description to keep tool result small.
  const desc = (vn as any).description as string | null;
  if (desc && desc.length > 1500) (vn as any).description = desc.slice(0, 1500) + "…";

  return { vn, tags: tagRows, producers: prodRows, related: relRows };
}

async function similarVns(env: Env, args: ToolArgs) {
  const limit = clampInt(args.limit, 1, 20, 8);
  let queryVector: number[] | null = null;

  if (args.id != null) {
    // Pull the existing embedding for this id from Vectorize.
    const fetched = await env.VEC.getByIds([String(Number(args.id))]);
    if (fetched.length > 0 && fetched[0].values) queryVector = Array.from(fetched[0].values);
  }
  if (!queryVector && args.text) {
    const out = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [String(args.text)] }) as { data: number[][] };
    queryVector = out.data[0];
  }
  if (!queryVector) return { error: "provide id or text" };

  const result = await env.VEC.query(queryVector, { topK: limit + (args.id != null ? 1 : 0), returnMetadata: "all" });
  const matches = result.matches
    .filter((m) => args.id == null || Number(m.id) !== Number(args.id))
    .slice(0, limit)
    .map((m) => ({ id: Number(m.id), title: (m.metadata as any)?.title ?? null, score: m.score }));
  return { matches };
}

async function listTags(env: Env, args: ToolArgs) {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query required" };
  const like = `%${query}%`;
  const { results } = await env.DB.prepare(
    `SELECT id, name, cat FROM tags WHERE name LIKE ? ORDER BY length(name) ASC LIMIT 10`,
  ).bind(like).all();
  return { results };
}

function clampInt(v: unknown, lo: number, hi: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
