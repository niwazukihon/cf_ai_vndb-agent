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

const MAX_TURNS = 6;
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

    let finalText = "";
    let assistantMsg: Message | null = null;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: working as any,
        tools: TOOL_SPECS as any,
      }) as AiResponse;

      // Log raw response shape for debugging (visible in `wrangler tail`).
      console.log("[agent] raw response:", JSON.stringify(response).slice(0, 500));

      const toolCalls = extractToolCalls(response);
      const text = extractText(response);

      console.log(`[agent] turn=${turn} toolCalls=${toolCalls.length} text=${!!text}`);

      // Workers AI flat tool-call format in the assistant message.
      assistantMsg = {
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

      // Execute each tool call and append a tool message per call.
      for (const call of toolCalls) {
        let result: unknown;
        try {
          const args = typeof call.function.arguments === "string"
            ? JSON.parse(call.function.arguments || "{}")
            : (call.function.arguments ?? {});
          console.log(`[tool] ${call.function.name}`, JSON.stringify(args).slice(0, 200));
          result = await runTool(this.env, call.function.name, args);
        } catch (e) {
          result = { error: String(e) };
        }
        // Workers AI expects tool results without tool_call_id.
        working.push({
          role: "tool",
          name: call.function.name,
          content: JSON.stringify(result).slice(0, 6000),
        });
      }
    }

    if (!finalText) finalText = "Sorry — I couldn't reach a final answer in time. Try rephrasing?";

    // Persist the final assistant turn.
    this.messages.push({ role: "assistant", content: finalText });
    await this.save();

    // Stream back as SSE so the UI can show progressive output (we just
    // emit one chunk because Workers AI tool-call mode is non-streaming).
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ text: finalText })}\n\n`));
        controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
        controller.close();
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
