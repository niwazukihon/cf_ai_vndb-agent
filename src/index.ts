import { ChatSession } from "./session";

export { ChatSession };

export interface Env {
  AI: Ai;
  DB: D1Database;
  VEC: VectorizeIndex;
  CHAT: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = await req.json().catch(() => null) as { sessionId?: string; message?: string } | null;
      if (!body?.sessionId || !body?.message) {
        return json({ error: "sessionId and message required" }, 400);
      }
      const id = env.CHAT.idFromName(body.sessionId);
      const stub = env.CHAT.get(id);
      return stub.fetch("https://do/chat", {
        method: "POST",
        body: JSON.stringify({ message: body.message }),
      });
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
      const body = await req.json().catch(() => null) as { sessionId?: string } | null;
      if (!body?.sessionId) return json({ error: "sessionId required" }, 400);
      const id = env.CHAT.idFromName(body.sessionId);
      const stub = env.CHAT.get(id);
      return stub.fetch("https://do/reset", { method: "POST" });
    }

    // Static assets (chat UI) — falls through to Pages-style asset binding.
    return env.ASSETS.fetch(req);
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
