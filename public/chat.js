// Minimal chat client. No frameworks, no build step.

const messagesEl = document.getElementById("messages");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const resetBtn = document.getElementById("reset");

const SESSION_KEY = "vndb-agent-session";
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, sessionId);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Linkify VN ids like v17, v12345 → https://vndb.org/v17
function linkify(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/\bv(\d+)\b/g, '<a href="https://vndb.org/v$1" target="_blank" rel="noopener">v$1</a>');
}

function addMessage(role, text, opts = {}) {
  const el = document.createElement("div");
  el.className = `msg ${role}` + (opts.thinking ? " thinking" : "");
  el.innerHTML = role === "assistant" ? linkify(text) : escapeHtml(text);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function formatToolArgs(args) {
  if (!args || typeof args !== "object") return "";
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    let s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.length > 30) s = s.slice(0, 30) + "…";
    parts.push(`${k}=${s}`);
  }
  return parts.join(", ");
}

function createAssistantShell() {
  const el = document.createElement("div");
  el.className = "msg assistant";
  const tools = document.createElement("div");
  tools.className = "tools";
  const answer = document.createElement("div");
  answer.className = "answer thinking";
  answer.textContent = "thinking…";
  el.appendChild(tools);
  el.appendChild(answer);
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { el, tools, answer };
}

function appendToolChip(toolsEl, name, args) {
  const chip = document.createElement("div");
  chip.className = "tool";
  const argText = formatToolArgs(args);
  chip.innerHTML = `<span class="tool-name">${escapeHtml(name)}</span>` +
    (argText ? `<span class="tool-args">(${escapeHtml(argText)})</span>` : "");
  toolsEl.appendChild(chip);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Auto-grow textarea
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.3) + "px";
});

// Enter to submit, Shift+Enter for newline
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  addMessage("user", text);
  sendBtn.disabled = true;

  const shell = createAssistantShell();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: text }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let final = "";
    let errMsg = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          if (obj.type === "tool") {
            appendToolChip(shell.tools, obj.name, obj.args);
          } else if (obj.type === "text") {
            final = obj.text;
          } else if (obj.type === "error") {
            errMsg = obj.message;
          } else if (obj.text) {
            // backwards compat
            final = obj.text;
          }
        } catch {}
      }
    }
    shell.answer.classList.remove("thinking");
    if (errMsg) {
      shell.answer.textContent = `error: ${errMsg}`;
    } else {
      shell.answer.innerHTML = linkify(final || "(empty response)");
    }
  } catch (err) {
    shell.answer.classList.remove("thinking");
    shell.answer.textContent = `error: ${err.message ?? err}`;
  } finally {
    sendBtn.disabled = false;
    input.focus();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
});

resetBtn.addEventListener("click", async () => {
  resetBtn.classList.remove("flashing");
  void resetBtn.offsetWidth; // restart animation
  resetBtn.classList.add("flashing");
  resetBtn.addEventListener("animationend", () => resetBtn.classList.remove("flashing"), { once: true });

  messagesEl.innerHTML = "";
  const m = document.querySelector("main");
  m.classList.remove("resetting");
  void m.offsetWidth;
  m.classList.add("resetting");
  m.addEventListener("animationend", () => m.classList.remove("resetting"), { once: true });

  await fetch("/api/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
});
