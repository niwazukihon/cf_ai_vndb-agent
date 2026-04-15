# AI Prompts Used

This project was built with AI-assisted coding using Claude (Opus 4.6) inside Claude Code. The prompts below are the human-authored instructions that shaped the implementation. Tool/system prompts injected by the harness are omitted.

## Planning

> I'm doing a cloudflare internship AI project. The instruction is in @Instruction.md . I want to make an app that allows users to ask questions about the visual novel database, vndb.org. The database is in @vndb\vndb-db-2026-04-14\ and the description of the database is at @"Database Dumps vndb.md". The database is large, but I want to make the app within the free tier provided by cloudflare, so I probably want to limit the database I used with the AI. The app should use cloudflare technology. It should have a web interface that allows users to ask questions about visual novels and the LLM should answer using vndb's data. Can you plan this app out?

Follow-up clarifications answered via multi-choice:

- **Use cases**: lookup/facts, filtered search, recommendations/similarity (no open-ended discussion).
- **DB scope**: top ~10k VNs by vote count.
- **AI architecture**: tool-calling agent (LLM picks structured tools).

> Go ahead with the plan. One more thing, make the web interface minimal, although it should adapt to different screen sizes (desktop/mobile).

## In-session system prompt for the agent itself

Embedded in `src/session.ts` as `SYSTEM_PROMPT`:

> You are a friendly assistant that helps users discover visual novels using the VNDB database.
>
> Rules:
> - ALWAYS call a tool before stating concrete facts (titles, ratings, release years, tags). Never invent VNs that the tools didn't return.
> - For "tell me about X" → call search_vns_by_name, then get_vn_details on the best match.
> - For "best/top X tagged Y after year Z" → call list_tags first to get tag ids, then filter_vns.
> - For "similar to X" or "I want a VN about Y" → call similar_vns (with id from a search, or with text).
> - Cite VNs in your final answer using the form v<id> (e.g. v17). The UI links them automatically.
> - Keep answers concise. Bullet points for lists. No more than ~6 recommendations at a time.
> - If the dataset doesn't contain a VN, say so honestly — the dataset is the top ~10k VNs by vote count.

## Tool descriptions (also acting as prompts to the LLM)

Each tool has a natural-language `description` field in `src/tools.ts` that the model uses to decide when to call it. Highlights:

- `search_vns_by_name` — "Search visual novels by (partial) title… Use this when the user names a specific VN."
- `filter_vns` — "Filter visual novels by year, tags, language, length, and minimum rating. Use this for queries like 'best mystery VNs released after 2018'. Tag names must come from list_tags first."
- `get_vn_details` — "Get full details for a single visual novel by id: description, top tags, developers/publishers, related VNs."
- `similar_vns` — "Find visual novels semantically similar to the given VN (by id) or to a free-text description. Use this for 'similar to X' or 'I want a VN about Y' queries."
- `list_tags` — "Look up tag ids by (partial) name. Use this BEFORE filter_vns whenever you need tag ids."
