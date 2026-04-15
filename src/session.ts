import type { Env } from "./index";
import { TOOL_SPECS, runTool } from "./tools";

/**
 * ChatSession Durable Object.
 *
 * Holds per-session conversation history and runs the tool-calling agent loop.
 * Each session id (provided by the client, stored in localStorage) maps to a
 * single DO instance — so we get cheap, stateful chat memory for free.
 */

type Role = "system" | "user" | "assistant" | "tool";
interface Message {
  role: Role;
  content: string;
  // Workers AI flat format: { name, arguments } (no id/type wrapper)
  tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  name?: string;
}
// Internal representation while running the loop (OpenAI-ish, normalised by extractToolCalls).
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const SYSTEM_PROMPT = `You are a friendly assistant that helps users discover visual novels using the VNDB database.

Rules:
- NEVER guess or recall a VN's numeric id from memory — ids in this dataset do not match common knowledge. ALWAYS call search_vns_by_name first to get the correct id, then call get_vn_details with that id.
- ALWAYS call a tool before stating any concrete fact (title, rating, release year, tags). Never invent information.
- For "tell me about X" → first call search_vns_by_name("X"), pick the best match from results, then call get_vn_details with that id.
- For "best/top X tagged Y after year Z" → call list_tags first to resolve tag names to ids, then call filter_vns.
- For "similar to X" or "I want a VN about Y" → call search_vns_by_name to get the id, then call similar_vns with that id.
- Cite VNs in your final answer using the form v<id> (e.g. v17). The UI links them automatically.
- Keep answers concise. Bullet points for lists. No more than ~6 recommendations at a time.
- If the dataset doesn't contain a VN, say so honestly — the dataset covers the top ~10k VNs by vote count.`;

const MAX_TURNS = 9;
const MAX_HISTORY = 20; // assistant+user pairs to keep around

export class ChatSession {
  state: DurableObjectState;
  env: Env;
  messages: Message[] = [];
  loaded = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async load() {
    if (this.loaded) return;
    const saved = await this.state.storage.get<Message[]>("messages");
    this.messages = saved ?? [];
    this.loaded = true;
  }

  async save() {
    // Trim: always keep the system message, then last MAX_HISTORY turns.
    const trimmed = this.messages.slice(-MAX_HISTORY * 4);
    await this.state.storage.put("messages", trimmed);
    this.messages = trimmed;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    await this.load();

    if (url.pathname === "/reset") {
      this.messages = [];
      await this.state.storage.delete("messages");
      return new Response("ok");
    }

    if (url.pathname === "/chat") {
      const { message } = await req.json() as { message: string };
      return this.handleChat(message);
    }

    return new Response("not found", { status: 404 });
  }

  async handleChat(userMessage: string): Promise<Response> {
    // Build the working message list (system + history + new user turn).
    const working: Message[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...this.messages,
      { role: "user", content: userMessage },
    ];
    // Persist the user turn immediately.
    this.messages.push({ role: "user", content: userMessage });

    const self = this;
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        let finalText = "";
        let lastAssistantText = "";
        // Track called signatures so we can short-circuit duplicate calls
        // instead of letting Llama spin in a loop.
        const calledSignatures = new Set<string>();

        try {
          for (let turn = 0; turn < MAX_TURNS; turn++) {
            const response = await self.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
              messages: working as any,
              tools: TOOL_SPECS as any,
            }) as AiResponse;

            console.log("[agent] raw response:", JSON.stringify(response).slice(0, 500));

            const toolCalls = extractToolCalls(response);
            const text = extractText(response);
            if (text && text.trim()) lastAssistantText = text;

            console.log(`[agent] turn=${turn} toolCalls=${toolCalls.length} text=${!!text}`);

            const assistantMsg: Message = {
              role: "assistant",
              content: text ?? "",
              ...(toolCalls.length > 0 ? {
                tool_calls: toolCalls.map((c) => ({
                  name: c.function.name,
                  arguments: typeof c.function.arguments === "string"
                    ? JSON.parse(c.function.arguments || "{}")
                    : (c.function.arguments ?? {}),
                })),
              } : {}),
            };
            working.push(assistantMsg);

            if (toolCalls.length === 0) {
              finalText = text ?? "(no response)";
              break;
            }

            let dupeDetected = false;
            for (const call of toolCalls) {
              let args: Record<string, unknown> = {};
              let result: unknown;
              try {
                args = typeof call.function.arguments === "string"
                  ? JSON.parse(call.function.arguments || "{}")
                  : (call.function.arguments ?? {});
              } catch {
                args = {};
              }
              const sig = `${call.function.name}:${JSON.stringify(args)}`;
              console.log(`[tool] ${call.function.name}`, JSON.stringify(args).slice(0, 200));
              send({ type: "tool", name: call.function.name, args });
              if (calledSignatures.has(sig)) {
                console.log(`[tool] duplicate call detected: ${sig.slice(0, 200)} — hard-breaking loop`);
                dupeDetected = true;
                break;
              }
              calledSignatures.add(sig);
              try {
                result = await runTool(self.env, call.function.name, args);
              } catch (e) {
                result = { error: String(e) };
              }
              working.push({
                role: "tool",
                name: call.function.name,
                content: JSON.stringify(result).slice(0, 6000),
              });

              // Auto-recovery: if get_vn_details returned not-found, the model
              // hallucinated an id. Run search_vns_by_name on the user's
              // original message and feed the result back in the same turn so
              // the model can pick up without giving up.
              const errStr = (result as any)?.error;
              if (call.function.name === "get_vn_details" && typeof errStr === "string" && errStr.includes("not found")) {
                const cleanedQuery = extractTitleFromUserMessage(userMessage);
                console.log(`[agent] get_vn_details miss — auto-running search_vns_by_name(query=${cleanedQuery})`);
                send({ type: "tool", name: "search_vns_by_name", args: { query: cleanedQuery } });
                let recovery: unknown;
                try {
                  recovery = await runTool(self.env, "search_vns_by_name", { query: cleanedQuery });
                } catch (e) {
                  recovery = { error: String(e) };
                }
                working.push({
                  role: "tool",
                  name: "search_vns_by_name",
                  content: JSON.stringify(recovery).slice(0, 6000),
                });
              }
            }
            if (dupeDetected) break;
          }

          // Loop ended without a clean text turn. Force a no-tools call so the
          // model has to summarise from the tool results it already gathered.
          if (!finalText) {
            try {
              console.log("[agent] forcing final answer (no tools)");
              const forced = await self.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
                messages: [
                  { role: "system", content: "TOOLS ARE DISABLED. You must produce a plain-text final answer for the user using ONLY the tool results that already appear in the conversation history. Do NOT output any tool call, JSON, or function-call syntax — output prose only. Cite VNs as v<id>. Be concise." },
                  ...working,
                  { role: "user", content: "Write the final answer now using only the tool results above." },
                ] as any,
              }) as AiResponse;
              const forcedText = extractText(forced);
              if (forcedText && forcedText.trim()) finalText = forcedText;
            } catch (e) {
              console.log("[agent] forced final-answer call failed:", String(e));
            }
          }

          // Last-ditch fallback: any text the model emitted along the way.
          if (!finalText && lastAssistantText) finalText = lastAssistantText;

          // Programmatic fallback: if the model produced nothing at all but we
          // do have tool results, render the most recent useful one as a list.
          if (!finalText) {
            const fallback = renderLastToolResult(working);
            if (fallback) finalText = fallback;
          }

          if (!finalText) finalText = "Sorry — I couldn't reach a final answer in time. Try rephrasing?";

          self.messages.push({ role: "assistant", content: finalText });
          await self.save();

          send({ type: "text", text: finalText });
        } catch (e) {
          send({ type: "error", message: String(e) });
        } finally {
          controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  }
}

// ---------- query cleaning ----------
//
// When auto-recovering from a hallucinated VN id, we re-search using the
// user's own message — but `search_vns_by_name` is a LIKE match against the
// title, so "Tell me about Steins;Gate" finds nothing. Strip common natural-
// language wrappers down to the bare title.

function extractTitleFromUserMessage(msg: string): string {
  let s = msg.trim();
  // Strip leading natural-language prefixes.
  s = s.replace(
    /^(please\s+)?(can you\s+)?(tell me (about|more about)|what(\s+is|'s)|who(\s+is|'s)|info(rmation)? on|details? on|describe|show me|find|search( for)?|look up|recommend(?:ations? for)?|i want to know about)\s+/i,
    "",
  );
  // Strip trailing punctuation and filler.
  s = s.replace(/[?!.\s]+$/g, "");
  s = s.replace(/^(the\s+visual novel\s+)/i, "");
  return s.trim() || msg.trim();
}

// ---------- programmatic fallback ----------
//
// If the model fails to produce any text at all but we have tool results,
// scan backwards for the most recent one that contains a list of VNs and
// render it as a markdown bullet list. Better than apologising.

function renderLastToolResult(working: Message[]): string | null {
  for (let i = working.length - 1; i >= 0; i--) {
    const m = working[i];
    if (m.role !== "tool") continue;
    let parsed: any;
    try { parsed = JSON.parse(m.content); } catch { continue; }
    if (parsed?.error) continue;
    const list: any[] | null =
      Array.isArray(parsed?.results) ? parsed.results :
      Array.isArray(parsed?.matches) ? parsed.matches :
      null;
    if (!list || list.length === 0) continue;
    const lines = list.slice(0, 8).map((row) => {
      const id = row.id;
      const title = row.title ?? "(untitled)";
      const year = row.year ? ` (${row.year})` : "";
      const rating = row.rating != null ? ` — rating ${Number(row.rating).toFixed(2)}` : "";
      return `- v${id} — ${title}${year}${rating}`;
    });
    return `Here's what I found:\n${lines.join("\n")}`;
  }
  return null;
}

// ---------- response shape helpers ----------
//
// Workers AI's Llama tool-calling response shape is in flux; handle both the
// OpenAI-style `tool_calls` field and the older `response`/`tool_call` shapes.

interface AiResponse {
  response?: string;
  tool_calls?: Array<{ name: string; arguments: unknown; id?: string }>;
  // OpenAI-style nested:
  choices?: Array<{ message: { content?: string; tool_calls?: ToolCall[] } }>;
}

function extractText(r: AiResponse): string | null {
  if (r.choices?.[0]?.message?.content) return r.choices[0].message.content;
  if (typeof r.response === "string") return r.response;
  return null;
}

function extractToolCalls(r: AiResponse): ToolCall[] {
  const choiceCalls = r.choices?.[0]?.message?.tool_calls;
  if (Array.isArray(choiceCalls)) return choiceCalls;
  if (Array.isArray(r.tool_calls)) {
    return r.tool_calls.map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
      },
    }));
  }
  return [];
}
