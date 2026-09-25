// <uno-chat> — a drop-in AI chat for any web page of an app on an Uno computer.
//
// Zero dependencies, one file, runs in the browser. It never sees the app's
// token: it talks to an endpoint of the app's own backend, which the SDK
// provides (Node: `uno.chatHandler()`, Python: `client.chat_sse()`), and the
// backend calls the computer's AI with the token. Contract: docs/app-sdk.md.
//
//   <script type="module" src="/uno/chat/uno-chat.js"></script>
//   <uno-chat endpoint="/uno/chat" greeting="Ask me about your notes"></uno-chat>
//
// or, without the tag:  UnoChat.mount(document.querySelector("#chat"), { endpoint: "/uno/chat" })
//
// The endpoint gets POST {"messages":[{"role":"user"|"assistant","content":"…"}]}
// and answers Server-Sent Events: `data: {"delta":"…"}` …, `data: {"error":{"message"}}`,
// `data: [DONE]`. OpenAI stream chunks (choices[0].delta.content) work too.

const STYLE = `
:host { display: block; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  --uno-chat-bg: #fff; --uno-chat-fg: #111; --uno-chat-muted: #6b7280; --uno-chat-border: #e5e7eb;
  --uno-chat-bubble: #f3f4f6; --uno-chat-accent: #4f46e5; --uno-chat-accent-fg: #fff;
  --uno-chat-code: #f6f8fa; height: 420px; }
@media (prefers-color-scheme: dark) { :host { --uno-chat-bg: #111318; --uno-chat-fg: #e5e7eb;
  --uno-chat-muted: #9ca3af; --uno-chat-border: #2a2e37; --uno-chat-bubble: #1c1f26; --uno-chat-code: #0b0d11; } }
.box { display: flex; flex-direction: column; height: 100%; box-sizing: border-box; background: var(--uno-chat-bg);
  color: var(--uno-chat-fg); border: 1px solid var(--uno-chat-border); border-radius: 12px; overflow: hidden; }
.head { padding: 8px 12px; font-weight: 600; border-bottom: 1px solid var(--uno-chat-border); font-size: 13px; }
.log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.msg { max-width: 85%; padding: 8px 11px; border-radius: 12px; overflow-wrap: anywhere; }
.msg.user { align-self: flex-end; background: var(--uno-chat-accent); color: var(--uno-chat-accent-fg); white-space: pre-wrap; }
.msg.assistant { align-self: flex-start; background: var(--uno-chat-bubble); }
.msg.error { align-self: stretch; max-width: none; background: transparent; color: #dc2626; font-size: 13px; }
.msg.hint { align-self: flex-start; background: transparent; color: var(--uno-chat-muted); padding: 0 2px; }
.msg p { margin: 0 0 6px; } .msg p:last-child { margin-bottom: 0; }
.msg ul, .msg ol { margin: 0 0 6px; padding-left: 20px; }
.msg pre { background: var(--uno-chat-code); padding: 8px; border-radius: 8px; overflow-x: auto; margin: 0 0 6px; }
.msg code { font: 12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.msg :not(pre) > code { background: var(--uno-chat-code); padding: 1px 4px; border-radius: 4px; }
.msg a { color: inherit; }
.typing::after { content: "▍"; animation: blink 1s steps(2) infinite; } @keyframes blink { 50% { opacity: 0; } }
form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--uno-chat-border); }
textarea { flex: 1; resize: none; font: inherit; color: inherit; background: transparent; border: 1px solid var(--uno-chat-border);
  border-radius: 8px; padding: 7px 9px; min-height: 20px; max-height: 120px; outline: none; }
textarea:focus { border-color: var(--uno-chat-accent); }
button { font: inherit; border: 0; border-radius: 8px; padding: 0 14px; background: var(--uno-chat-accent);
  color: var(--uno-chat-accent-fg); cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
`;

const ESCAPES = /** @type {Record<string, string>} */ ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});
/** @param {string} text */
export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Inline markdown on already-escaped text: `code`, **bold**, *italic*, [text](https://…). */
function inline(/** @type {string} */ escaped) {
  const codes = /** @type {string[]} */ ([]);
  let out = escaped.replace(/`([^`\n]+)`/g, (_m, code) => {
    codes.push(code);
    return `\uE000${codes.length - 1}\uE000`;
  });
  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
  return out.replace(/\uE000(\d+)\uE000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
}

/**
 * Markdown-light → safe HTML: everything is escaped first; only paragraphs,
 * line breaks, lists, fenced code, inline code, bold, italic, headings (as
 * bold lines) and http(s) links come back. No raw HTML from the model.
 * @param {string} text
 */
export function renderMarkdown(text) {
  const parts = text.split(/```/);
  let html = "";
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const body = part.replace(/^[\w+-]*\n/, "");
      html += `<pre><code>${escapeHtml(body.replace(/\n$/, ""))}</code></pre>`;
      return;
    }
    const blocks = part.split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      if (lines.length === 0) continue;
      const bullet = /^\s*[-*•]\s+/;
      const numbered = /^\s*\d+[.)]\s+/;
      if (lines.every((l) => bullet.test(l))) {
        html += `<ul>${lines.map((l) => `<li>${inline(escapeHtml(l.replace(bullet, "")))}</li>`).join("")}</ul>`;
      } else if (lines.every((l) => numbered.test(l))) {
        html += `<ol>${lines.map((l) => `<li>${inline(escapeHtml(l.replace(numbered, "")))}</li>`).join("")}</ol>`;
      } else {
        const body = lines
          .map((l) => {
            const heading = /^\s*#{1,6}\s+(.*)$/.exec(l);
            return heading
              ? `<strong>${inline(escapeHtml(heading[1] ?? ""))}</strong>`
              : inline(escapeHtml(l));
          })
          .join("<br>");
        html += `<p>${body}</p>`;
      }
    }
  });
  return html;
}

/**
 * The text an SSE `data:` line carries: our `{delta}`, an OpenAI chunk, or
 * an error. `done` on `[DONE]`.
 * @param {string} data
 * @returns {{delta?: string, error?: string, done?: boolean}}
 */
export function parseChatEvent(data) {
  const trimmed = data.trim();
  if (trimmed === "[DONE]") return { done: true };
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return {};
  }
  if (value?.error) {
    const e = value.error;
    return { error: typeof e === "string" ? e : String(e.message ?? "The AI failed.") };
  }
  if (typeof value?.delta === "string") return { delta: value.delta };
  const openai = value?.choices?.[0]?.delta?.content;
  return typeof openai === "string" ? { delta: openai } : {};
}

/** @param {ReadableStream<Uint8Array>} body */
async function* sseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  }
}

/**
 * @typedef {{ endpoint?: string, greeting?: string, placeholder?: string, heading?: string,
 *   headers?: Record<string, string> }} UnoChatOptions
 */

const BaseElement = /** @type {typeof HTMLElement} */ (
  typeof HTMLElement === "undefined" ? class {} : HTMLElement
);

export class UnoChatElement extends BaseElement {
  static get observedAttributes() {
    return ["endpoint", "greeting", "placeholder", "heading"];
  }

  constructor() {
    super();
    /** @type {Array<{role: "user" | "assistant", content: string}>} */
    this.messages = [];
    /** @type {UnoChatOptions} */
    this.options = {};
    /** @type {AbortController | null} */
    this.running = null;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style><div class="box" part="box"><div class="head" part="head" hidden></div><div class="log" part="log" role="log" aria-live="polite"></div><form part="form"><textarea rows="1" aria-label="Message"></textarea><button type="submit">Send</button></form></div>`;
    this.log = /** @type {HTMLElement} */ (root.querySelector(".log"));
    this.head = /** @type {HTMLElement} */ (root.querySelector(".head"));
    this.input = /** @type {HTMLTextAreaElement} */ (root.querySelector("textarea"));
    this.button = /** @type {HTMLButtonElement} */ (root.querySelector("button"));
    const form = /** @type {HTMLFormElement} */ (root.querySelector("form"));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.running) this.running.abort();
      else void this.send(this.input.value);
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    this.input.addEventListener("input", () => {
      this.input.style.height = "auto";
      this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`;
    });
  }

  connectedCallback() {
    this.refresh();
  }

  attributeChangedCallback() {
    this.refresh();
  }

  get endpoint() {
    return this.options.endpoint || this.getAttribute("endpoint") || "/uno/chat";
  }

  refresh() {
    const title = this.options.heading ?? this.getAttribute("heading");
    this.head.hidden = !title;
    this.head.textContent = title || "";
    this.input.placeholder =
      this.options.placeholder ?? this.getAttribute("placeholder") ?? "Ask something…";
    if (this.messages.length === 0) {
      const greeting = this.options.greeting ?? this.getAttribute("greeting");
      this.log.replaceChildren();
      if (greeting) this.bubble("hint", greeting);
    }
  }

  /** @param {string} kind @param {string} text */
  bubble(kind, text) {
    const el = document.createElement("div");
    el.className = `msg ${kind}`;
    if (kind === "assistant") el.innerHTML = renderMarkdown(text);
    else el.textContent = text;
    this.log.append(el);
    this.log.scrollTop = this.log.scrollHeight;
    return el;
  }

  /** Start over (the page keeps no history of its own). */
  clear() {
    this.running?.abort();
    this.messages = [];
    this.refresh();
  }

  /** @param {string} text */
  async send(text) {
    const content = text.trim();
    if (!content || this.running) return;
    this.input.value = "";
    this.input.style.height = "auto";
    this.messages.push({ role: "user", content });
    this.bubble("user", content);
    const out = this.bubble("assistant", "");
    out.classList.add("typing");
    const controller = new AbortController();
    this.running = controller;
    this.button.textContent = "Stop";
    let answer = "";
    let frame = 0;
    const paint = () => {
      frame = 0;
      out.innerHTML = renderMarkdown(answer);
      this.log.scrollTop = this.log.scrollHeight;
    };
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.options.headers },
        body: JSON.stringify({ messages: this.messages }),
        signal: controller.signal,
        credentials: "same-origin",
      });
      if (!res.ok || !res.body) {
        let message = `The chat answered ${res.status}.`;
        try {
          const data = await res.json();
          message = String(data?.error?.message ?? data?.error ?? message);
        } catch {
          // not JSON
        }
        throw new Error(message);
      }
      for await (const data of sseData(res.body)) {
        const event = parseChatEvent(data);
        if (event.error) throw new Error(event.error);
        if (event.done) break;
        if (event.delta) {
          answer += event.delta;
          if (!frame) frame = requestAnimationFrame(paint);
        }
      }
      if (frame) cancelAnimationFrame(frame);
      paint();
      if (answer) this.messages.push({ role: "assistant", content: answer });
      else out.remove();
      this.dispatchEvent(new CustomEvent("uno-chat-answer", { detail: { text: answer } }));
    } catch (error) {
      if (frame) cancelAnimationFrame(frame);
      if (/** @type {any} */ (error)?.name === "AbortError") {
        if (answer) {
          paint();
          this.messages.push({ role: "assistant", content: answer });
        } else out.remove();
      } else {
        if (answer) paint();
        else out.remove();
        this.bubble("error", /** @type {any} */ (error)?.message || String(error));
      }
    } finally {
      out.classList.remove("typing");
      this.running = null;
      this.button.textContent = "Send";
      this.input.focus();
    }
  }
}

export const UnoChat = {
  /**
   * Put a chat into `el` (its content is replaced). Returns the element.
   * @param {Element} el
   * @param {UnoChatOptions} [options]
   */
  mount(el, options = {}) {
    define();
    const chat = /** @type {UnoChatElement} */ (document.createElement("uno-chat"));
    chat.options = options;
    el.replaceChildren(chat);
    chat.refresh();
    return chat;
  },
};

export function define() {
  if (typeof customElements !== "undefined" && !customElements.get("uno-chat")) {
    customElements.define("uno-chat", UnoChatElement);
  }
}

if (typeof window !== "undefined") {
  define();
  /** @type {any} */ (window).UnoChat = UnoChat;
}
