// Uno App SDK — "the AI of this computer" for any app on it.
//
// One zero-dependency ESM file (Node >= 18, Bun). The Uno Work daemon keeps a
// copy at ~/.uno/sdk/js/uno-app.mjs (+ uno-app.d.ts) on every machine; the
// same file is published as `@uno4/app`. Contract: docs/app-sdk.md.
//
//   import { ask, stream, task } from "/home/unowork/.uno/sdk/js/uno-app.mjs";
//   const text = await ask("Translate to English: привет");
//
// Config, first match wins: explicit options → env UNO_APP_API_URL +
// UNO_APP_TOKEN → UNO_APP_KEY_DIR → /run/uno-app (docker mount) →
// ~/.uno/app-keys/<appId>/ (appId = option or env UNO_APP_ID).

export const DEFAULT_URL = "http://127.0.0.1:3779";
const DOCKER_KEY_DIR = "/run/uno-app";
const TOKEN_WAIT_MS = 15_000;
const TOKEN_POLL_MS = 500;
const TASK_POLL_WAIT_MS = 30_000;
const TASK_WAITING_PAUSE_MS = 2_000;

/** An error answered by the App API (or a config problem, status 0). */
export class UnoAppError extends Error {
  /**
   * @param {number} status HTTP status (0 = no response / config problem)
   * @param {string} code machine code, e.g. "app_limit_reached"
   * @param {string} message human-readable message
   * @param {string} [type]
   */
  constructor(status, code, message, type) {
    super(message);
    this.name = "UnoAppError";
    this.status = status;
    this.code = code;
    this.type = type ?? "";
  }
}

// ---- node builtins, loaded lazily so the file also imports in a browser ----

/** @type {Promise<{fs: any, os: any, path: any} | null> | null} */
let nodePromise = null;
function nodeBuiltins() {
  if (!nodePromise) {
    nodePromise = (async () => {
      try {
        const [fs, os, path] = await Promise.all([
          import("node:fs"),
          import("node:os"),
          import("node:path"),
        ]);
        return { fs, os, path };
      } catch {
        return null;
      }
    })();
  }
  return nodePromise;
}

/** @returns {Record<string, string | undefined>} */
function env() {
  const p = /** @type {any} */ (globalThis).process;
  return (p && p.env) || {};
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {any} node
 * @param {string} file
 */
function readText(node, file) {
  try {
    return node.fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Token and addresses from one key folder ({token, api.json}).
 * @param {any} node
 * @param {string} dir
 */
function readKeyDir(node, dir) {
  /** @type {{appId?: string, url?: string, dockerUrl?: string, token?: string}} */
  let api = {};
  const raw = readText(node, node.path.join(dir, "api.json"));
  if (raw) {
    try {
      api = JSON.parse(raw) || {};
    } catch {
      api = {};
    }
  }
  const token = readText(node, node.path.join(dir, "token")) || api.token || "";
  return { dir, token, api };
}

/**
 * Resolve where the App API is and which token to use.
 * @param {{url?: string, token?: string, appId?: string, waitMs?: number}} [opts]
 * @returns {Promise<{url: string, token: string, appId: string, source: string}>}
 */
export async function resolveConfig(opts = {}) {
  const e = env();
  const appId = opts.appId || e.UNO_APP_ID || "";
  const envUrl = e.UNO_APP_API_URL || "";
  const token = opts.token || e.UNO_APP_TOKEN || "";
  if (token) {
    return {
      url: trimSlash(opts.url || envUrl || DEFAULT_URL),
      token,
      appId,
      source: opts.token ? "options" : "env",
    };
  }

  const node = await nodeBuiltins();
  if (!node) {
    throw new UnoAppError(
      0,
      "no_app_token",
      "No Uno app token: pass {url, token} to createClient() (no filesystem here).",
    );
  }
  /** @type {string[]} */
  const dirs = [];
  let designated = false;
  if (e.UNO_APP_KEY_DIR) {
    dirs.push(e.UNO_APP_KEY_DIR);
    designated = true;
  }
  if (node.fs.existsSync(DOCKER_KEY_DIR)) {
    dirs.push(DOCKER_KEY_DIR);
    designated = true;
  }
  if (appId) {
    dirs.push(node.path.join(node.os.homedir(), ".uno", "app-keys", appId));
    designated = true;
  }
  const inDocker = node.fs.existsSync("/.dockerenv");
  const deadline = Date.now() + (designated ? (opts.waitMs ?? TOKEN_WAIT_MS) : 0);
  for (;;) {
    for (const dir of dirs) {
      const k = readKeyDir(node, dir);
      if (!k.token) continue;
      const docker = inDocker || dir === DOCKER_KEY_DIR;
      const fileUrl = (docker && k.api.dockerUrl) || k.api.url || "";
      return {
        url: trimSlash(opts.url || envUrl || fileUrl || DEFAULT_URL),
        token: k.token,
        appId: appId || k.api.appId || "",
        source: dir,
      };
    }
    if (Date.now() >= deadline) break;
    await sleep(TOKEN_POLL_MS);
  }
  throw new UnoAppError(
    0,
    "no_app_token",
    `No Uno app token. Add "ai": {"chat": true} to ~/.uno/apps/${appId || "<id>"}.json`,
  );
}

/** @param {string} s */
function trimSlash(s) {
  return s.replace(/\/+$/, "");
}

// ---- HTTP -----------------------------------------------------------------

/**
 * @param {Response} res
 * @returns {Promise<UnoAppError>}
 */
async function toError(res) {
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  let code = "";
  let message = "";
  let type = "";
  try {
    const body = JSON.parse(text);
    const err = body && body.error;
    if (err && typeof err === "object") {
      type = String(err.type ?? "");
      // The Uno gateway puts the machine code in `type` and the HTTP status in `code`.
      code = typeof err.code === "string" && err.code ? err.code : type;
      message = String(err.message ?? "");
    } else if (typeof err === "string") {
      message = err;
    }
  } catch {
    message = text.slice(0, 300);
  }
  return new UnoAppError(
    res.status,
    code || `http_${res.status}`,
    message || `HTTP ${res.status}`,
    type,
  );
}

/**
 * Parse a Server-Sent Events body into {event, data} records.
 * @param {ReadableStream<Uint8Array> | null} body
 * @returns {AsyncGenerator<{event: string, data: string}>}
 */
export async function* parseSSE(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  /** @type {string[]} */
  let data = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) yield { event: event || "message", data: data.join("\n") };
          event = "";
          data = [];
        } else if (line.startsWith(":")) {
          // comment / keep-alive
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
    buf += decoder.decode();
    if (buf.startsWith("data:")) data.push(buf.slice(5).replace(/^ /, ""));
    if (data.length) yield { event: event || "message", data: data.join("\n") };
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * @param {string | Array<{role: string, content: any}>} input
 * @param {string} [system]
 */
function toMessages(input, system) {
  const messages =
    typeof input === "string" ? [{ role: "user", content: input }] : [...(input || [])];
  if (system) messages.unshift({ role: "system", content: system });
  return messages;
}

/** @param {any} opts */
function chatBody(input, opts = {}) {
  /** @type {Record<string, any>} */
  const body = { model: opts.model || "default", messages: toMessages(input, opts.system) };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  return body;
}

/**
 * @param {any} file
 * @param {string | undefined} filename
 * @param {any} node
 * @returns {Promise<{blob: Blob, name: string}>}
 */
async function toBlob(file, filename, node) {
  if (typeof file === "string") {
    if (!node) throw new UnoAppError(0, "invalid_request", "File paths need Node or Bun");
    const bytes = await node.fs.promises.readFile(file);
    return { blob: new Blob([bytes]), name: filename || node.path.basename(file) };
  }
  if (typeof Blob !== "undefined" && file instanceof Blob) {
    return { blob: file, name: filename || /** @type {any} */ (file).name || "audio" };
  }
  if (file instanceof ArrayBuffer || ArrayBuffer.isView(file)) {
    return { blob: new Blob([/** @type {any} */ (file)]), name: filename || "audio" };
  }
  throw new UnoAppError(0, "invalid_request", "transcribe() takes a path, Blob, Buffer or bytes");
}

/**
 * A client bound to one App API address and token.
 * @param {{url?: string, token?: string, appId?: string, fetch?: typeof fetch}} [options]
 */
export function createClient(options = {}) {
  /** @type {Promise<{url: string, token: string, appId: string, source: string}> | null} */
  let configPromise = null;
  const doFetch = options.fetch || ((...a) => globalThis.fetch(...a));

  function config() {
    if (!configPromise) {
      configPromise = resolveConfig(options);
      configPromise.catch(() => {
        configPromise = null;
      });
    }
    return configPromise;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {{json?: any, body?: any, signal?: AbortSignal}} [init]
   * @returns {Promise<Response>}
   */
  async function request(method, path, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const cfg = await config();
      /** @type {Record<string, string>} */
      const headers = { Authorization: `Bearer ${cfg.token}` };
      let body = init.body;
      if (init.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(init.json);
      }
      let res;
      try {
        res = await doFetch(cfg.url + path, {
          method,
          headers,
          body,
          signal: init.signal,
        });
      } catch (err) {
        if (/** @type {any} */ (err)?.name === "AbortError") throw err;
        throw new UnoAppError(
          0,
          "unreachable",
          `Cannot reach the Uno App API at ${cfg.url}: ${/** @type {any} */ (err)?.message ?? err}`,
        );
      }
      if (res.ok) return res;
      // The person pressed Revoke (token rotated): re-read the key files once.
      if (res.status === 401 && attempt === 0 && cfg.source !== "options" && cfg.source !== "env") {
        configPromise = null;
        const next = await config().catch(() => cfg);
        if (next.token !== cfg.token) {
          await res.body?.cancel().catch(() => {});
          continue;
        }
      }
      throw await toError(res);
    }
  }

  /** @param {string} method @param {string} path @param {any} [json] @param {AbortSignal} [signal] */
  async function json(method, path, json, signal) {
    const res = await request(method, path, { json, signal });
    return res.json();
  }

  /** @param {any} body @param {{signal?: AbortSignal}} [o] */
  function chat(body, o = {}) {
    return json("POST", "/v1/chat/completions", body, o.signal);
  }

  /** @param {any} input @param {any} [opts] */
  async function ask(input, opts = {}) {
    const data = await chat(chatBody(input, opts), opts);
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  }

  /** @param {any} input @param {any} [opts] */
  async function* stream(input, opts = {}) {
    const res = await request("POST", "/v1/chat/completions", {
      json: { ...chatBody(input, opts), stream: true },
      signal: opts.signal,
    });
    for await (const { data } of parseSSE(res.body)) {
      if (data.trim() === "[DONE]") return;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk?.error) {
        const err = chunk.error;
        throw new UnoAppError(0, String(err.code ?? "stream_error"), String(err.message ?? err));
      }
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) yield delta;
    }
  }

  /** @param {any} file @param {any} [opts] */
  async function transcribeJson(file, opts = {}) {
    const node = await nodeBuiltins();
    const { blob, name } = await toBlob(file, opts.filename, node);
    const form = new FormData();
    form.append("file", blob, name);
    if (opts.model) form.append("model", opts.model);
    if (opts.language) form.append("language", opts.language);
    form.append("response_format", opts.responseFormat || "json");
    const res = await request("POST", "/v1/audio/transcriptions", {
      body: form,
      signal: opts.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  /** @param {any} file @param {any} [opts] */
  async function transcribe(file, opts = {}) {
    const data = await transcribeJson(file, opts);
    return typeof data?.text === "string" ? data.text : "";
  }

  /** @param {any} data */
  function makeTask(data) {
    const id = String(data.id);
    const t = {
      ...data,
      id,
      /** @param {{timeoutMs?: number, untilDone?: boolean, signal?: AbortSignal}} [o] */
      async wait(o = {}) {
        const untilDone = o.untilDone !== false;
        const deadline = o.timeoutMs === undefined ? Infinity : Date.now() + o.timeoutMs;
        let last = data;
        for (;;) {
          const left = deadline - Date.now();
          const waitMs = Math.max(0, Math.min(TASK_POLL_WAIT_MS, left));
          last = await json(
            "GET",
            `/v1/tasks/${encodeURIComponent(id)}?waitMs=${Math.floor(waitMs)}`,
            undefined,
            o.signal,
          );
          Object.assign(t, last);
          const s = last?.status;
          if (s !== "running" && (s !== "waiting" || !untilDone)) return last;
          if (Date.now() >= deadline) return last;
          if (s === "waiting") {
            await sleep(Math.min(TASK_WAITING_PAUSE_MS, Math.max(0, deadline - Date.now())));
          }
        }
      },
      /** @param {{signal?: AbortSignal}} [o] */
      async *events(o = {}) {
        const res = await request("GET", `/v1/tasks/${encodeURIComponent(id)}/events`, {
          signal: o.signal,
        });
        for await (const ev of parseSSE(res.body)) {
          let parsed;
          try {
            parsed = JSON.parse(ev.data);
          } catch {
            parsed = ev.data;
          }
          yield { event: ev.event, data: parsed };
          if (ev.event === "done") return;
        }
      },
      async stop() {
        const r = await json("POST", `/v1/tasks/${encodeURIComponent(id)}/stop`, {});
        if (r && typeof r === "object") Object.assign(t, r);
        return r;
      },
    };
    return t;
  }

  /** @param {{prompt: string, cwd?: string, title?: string, harness?: string, tools?: string, signal?: AbortSignal}} spec */
  async function task(spec) {
    const { signal, ...body } = spec;
    const data = await json("POST", "/v1/tasks", body, signal);
    return makeTask(data);
  }

  /** @param {string} id */
  async function getTask(id) {
    return makeTask(await json("GET", `/v1/tasks/${encodeURIComponent(id)}`));
  }

  async function tasks() {
    return json("GET", "/v1/tasks");
  }

  async function whoami() {
    return json("GET", "/v1/whoami");
  }

  async function models() {
    return json("GET", "/v1/models");
  }

  return {
    ask,
    stream,
    chat,
    transcribe,
    transcribeJson,
    task,
    getTask,
    tasks,
    whoami,
    models,
    config,
  };
}

// ---- top-level functions on a lazily created default client ----------------

/** @type {ReturnType<typeof createClient> | null} */
let defaultClient = null;
function client() {
  if (!defaultClient) defaultClient = createClient();
  return defaultClient;
}

/** @type {any} */
export const ask = (input, opts) => client().ask(input, opts);
/** @type {any} */
export const stream = (input, opts) => client().stream(input, opts);
/** @type {any} */
export const chat = (body, opts) => client().chat(body, opts);
/** @type {any} */
export const transcribe = (file, opts) => client().transcribe(file, opts);
/** @type {any} */
export const transcribeJson = (file, opts) => client().transcribeJson(file, opts);
/** @type {any} */
export const task = (spec) => client().task(spec);
/** @type {any} */
export const getTask = (id) => client().getTask(id);
/** @type {any} */
export const tasks = () => client().tasks();
/** @type {any} */
export const whoami = () => client().whoami();
/** @type {any} */
export const models = () => client().models();
