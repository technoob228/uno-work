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
    `No Uno app token. Add "ai": {"chat": true} and/or "storage": true to ~/.uno/apps/${appId || "<id>"}.json`,
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
   * @param {{json?: any, body?: any, headers?: Record<string, string>, signal?: AbortSignal}} [init]
   * @returns {Promise<Response>}
   */
  async function request(method, path, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const cfg = await config();
      /** @type {Record<string, string>} */
      const headers = { ...init.headers, Authorization: `Bearer ${cfg.token}` };
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
          // A stream body (a big file) needs half-duplex in Node's fetch.
          ...(body && typeof body.getReader === "function" ? { duplex: "half" } : {}),
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
      headers: opts.headers,
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

  /**
   * Tell the person something — it lands in the Inbox of Uno Work (manifest
   * `"notify": true`). `open`: `{file: "~/…"}`, `{url: "https://…"}` or
   * `{app: true, path: "/…"}` (this app, inside Uno). Same `group` while
   * unread → one item that updates instead of many.
   * @param {string | {title: string, body?: string, open?: any, group?: string}} input
   * @param {{body?: string, open?: any, group?: string}} [opts]
   */
  async function notify(input, opts = {}) {
    const payload = typeof input === "string" ? { title: input, ...opts } : input;
    return json("POST", "/v1/notify", payload);
  }

  // ---- cloud storage: the app's own folder in the account's cloud --------

  /** @param {string} key */
  function filePath(key) {
    const folder = typeof key === "string" && key.endsWith("/");
    const clean = typeof key === "string" ? (folder ? key.slice(0, -1) : key) : "";
    // Checked here too: fetch would quietly resolve "../" in the URL path.
    if (clean === "" || clean.split("/").some((s) => s === "" || s === "." || s === "..")) {
      throw new UnoAppError(400, "invalid_key", 'A file key looks like "photos/cat.jpg".');
    }
    const encoded = clean.split("/").map(encodeURIComponent).join("/");
    return `/v1/storage/files/${encoded}${folder ? "?folder=1" : ""}`;
  }

  /**
   * @param {any} data
   * @param {string} key
   * @param {string | undefined} contentType
   * @returns {Promise<{body: any, type: string, size: number | null}>}
   */
  async function toUploadBody(data, key, contentType) {
    const guessed = contentType || guessContentType(key);
    if (typeof data === "string") {
      const bytes = new TextEncoder().encode(data);
      return {
        body: bytes,
        type: contentType || (guessed === DEFAULT_TYPE ? "text/plain; charset=utf-8" : guessed),
        size: bytes.byteLength,
      };
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return { body: data, type: contentType || data.type || guessed, size: data.size };
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return { body: bytes, type: guessed, size: bytes.byteLength };
    }
    throw new UnoAppError(
      0,
      "invalid_request",
      "storage.put() takes a string, Blob, Buffer or bytes; use storage.upload(path, key) for a file on disk.",
    );
  }

  const storage = {
    /** @param {string} key @param {any} data @param {{contentType?: string, signal?: AbortSignal}} [o] */
    async put(key, data, o = {}) {
      const { body, type } = await toUploadBody(data, key, o.contentType);
      const res = await request("PUT", filePath(key), {
        body,
        headers: { "Content-Type": type },
        signal: o.signal,
      });
      return res.json();
    },
    /** @param {string} key @param {any} value */
    async putJson(key, value) {
      return storage.put(key, JSON.stringify(value), { contentType: "application/json" });
    },
    /** Upload a file from disk (Node/Bun), streamed. */
    async upload(/** @type {string} */ localPath, /** @type {string} */ key, o = {}) {
      const node = await nodeBuiltins();
      if (!node) throw new UnoAppError(0, "invalid_request", "upload() needs Node or Bun");
      const target = key || node.path.basename(localPath);
      const fs = node.fs;
      /** @type {any} */
      let blob;
      if (typeof fs.openAsBlob === "function") {
        blob = await fs.openAsBlob(localPath);
      } else {
        blob = new Blob([await fs.promises.readFile(localPath)]);
      }
      return storage.put(target, blob, {
        contentType: /** @type {any} */ (o).contentType || guessContentType(target),
        signal: /** @type {any} */ (o).signal,
      });
    },
    /** The raw Response (streaming body, Range supported) — pipe it to a browser. */
    async open(
      /** @type {string} */ key,
      o = /** @type {{range?: string, signal?: AbortSignal}} */ ({}),
    ) {
      return request("GET", filePath(key), {
        headers: o.range ? { Range: o.range } : {},
        signal: o.signal,
      });
    },
    /** @param {string} key @returns {Promise<Uint8Array>} */
    async get(key) {
      const res = await storage.open(key);
      return new Uint8Array(await res.arrayBuffer());
    },
    /** @param {string} key */
    async getText(key) {
      const res = await storage.open(key);
      return res.text();
    },
    /** @param {string} key */
    async getJson(key) {
      const res = await storage.open(key);
      return res.json();
    },
    /** Download to a file on disk (Node/Bun). */
    async download(/** @type {string} */ key, /** @type {string} */ localPath) {
      const node = await nodeBuiltins();
      if (!node) throw new UnoAppError(0, "invalid_request", "download() needs Node or Bun");
      const res = await storage.open(key);
      const { Readable } = await import("node:stream");
      const { pipeline } = await import("node:stream/promises");
      await pipeline(
        Readable.fromWeb(/** @type {any} */ (res.body)),
        node.fs.createWriteStream(localPath),
      );
      return localPath;
    },
    /** true when the file is there. */
    async exists(/** @type {string} */ key) {
      try {
        await request("HEAD", filePath(key));
        return true;
      } catch (err) {
        if (err instanceof UnoAppError && err.status === 404) return false;
        throw err;
      }
    },
    /** One folder level: {prefix, folders: ["photos/2026/"], files: [{key, name, size, modifiedAt}]}. */
    async list(prefix = "") {
      return json("GET", `/v1/storage/list?prefix=${encodeURIComponent(prefix)}`);
    },
    /** Every file under a folder, walking sub-folders. */
    async listAll(prefix = "") {
      /** @type {any[]} */
      const out = [];
      const queue = [prefix];
      while (queue.length) {
        const level = await storage.list(/** @type {string} */ (queue.shift()));
        out.push(...level.files);
        queue.push(...level.folders);
      }
      return out;
    },
    /** Delete a file, or a whole folder when the key ends in "/". */
    async delete(/** @type {string} */ key) {
      const res = await request("DELETE", filePath(key));
      return res.json();
    },
    /**
     * A temporary https link to the file (default 15 min, at most 1 h) — put
     * it in <img src>, <a href> or a redirect so the browser downloads
     * straight from the cloud, not through your app.
     */
    async url(/** @type {string} */ key, o = /** @type {{expiresIn?: number}} */ ({})) {
      const data = await json("POST", "/v1/storage/url", { key, expiresIn: o.expiresIn });
      return String(data.url);
    },
    /** {folder, usedBytes, limitBytes, remainingBytes, files}. */
    async usage() {
      return json("GET", "/v1/storage");
    },
  };

  /**
   * A request handler for `<uno-chat>` (uno-chat.js): `GET …/uno-chat.js`
   * serves the component, `POST …` streams an answer from this computer's AI.
   * The browser never gets the app's token — only this server has it.
   * Works as a plain `node:http` handler and as Express/Connect middleware:
   *   app.use("/uno/chat", uno.chatHandler({ system: "You help with notes." }))
   * @param {ChatHandlerOptions} [opts]
   */
  function chatHandler(opts = {}) {
    const maxMessages = opts.maxMessages ?? 20;
    const maxChars = opts.maxChars ?? 8000;
    /** @param {any} req @param {any} res @param {(err?: any) => void} [next] */
    return async function unoChat(req, res, next) {
      const path = String(req.url || "/").split("?")[0] || "/";
      if (req.method === "GET" || req.method === "HEAD") {
        if (!path.endsWith("/uno-chat.js")) return next ? next() : endJson(res, 404, "Not found");
        const source = await chatComponentSource();
        if (source === null) {
          return endJson(res, 404, "uno-chat.js is not next to uno-app.mjs");
        }
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=300",
        });
        return res.end(req.method === "HEAD" ? undefined : source);
      }
      if (req.method !== "POST") return next ? next() : endJson(res, 405, "Use POST");
      try {
        if (opts.allow && !(await opts.allow(req))) return endJson(res, 403, "Not allowed");
      } catch {
        return endJson(res, 403, "Not allowed");
      }
      let body = req.body;
      if (body === undefined || body === null || typeof body !== "object") {
        try {
          body = JSON.parse((await readRequest(req, 512 * 1024)) || "{}");
        } catch {
          return endJson(res, 400, 'Send JSON: {"messages": [...]}');
        }
      }
      const messages = cleanChatMessages(body?.messages, { maxMessages, maxChars });
      if (messages.length === 0 || messages[messages.length - 1]?.role !== "user") {
        return endJson(res, 400, "The last message must be the person's.");
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableFinished) controller.abort();
      };
      res.on?.("close", onClose);
      const write = (/** @type {any} */ data) => {
        if (!controller.signal.aborted) res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      try {
        for await (const delta of stream(messages, {
          system: opts.system,
          model: opts.model,
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
          signal: controller.signal,
          // Uno Work warns the person when a chat without sign-in is on the
          // internet ("Anyone with the link can use this app's AI").
          headers: { "X-Uno-Chat-Widget": "1", "X-Uno-Chat-Guarded": opts.allow ? "1" : "0" },
        })) {
          write({ delta });
        }
      } catch (err) {
        if (/** @type {any} */ (err)?.name !== "AbortError") {
          write({
            error: {
              code: /** @type {any} */ (err)?.code ?? "error",
              message: friendlyChatError(err),
            },
          });
        }
      } finally {
        if (!controller.signal.aborted) res.write("data: [DONE]\n\n");
        res.off?.("close", onClose);
        res.end();
      }
    };
  }

  return {
    ask,
    stream,
    chat,
    chatHandler,
    transcribe,
    transcribeJson,
    task,
    getTask,
    tasks,
    whoami,
    models,
    notify,
    storage,
    config,
  };
}

// ---- <uno-chat> backend helpers ----------------------------------------------

/**
 * @typedef {{
 *   system?: string, model?: string, temperature?: number, maxTokens?: number,
 *   maxMessages?: number, maxChars?: number,
 *   allow?: (req: any) => boolean | Promise<boolean>,
 * }} ChatHandlerOptions
 */

/**
 * What the browser may send: only "user" / "assistant" turns with text, the
 * last `maxMessages`, each cut to `maxChars`. A "system" turn from the page is
 * dropped — the system prompt is the server's (`opts.system`).
 * @param {any} input
 * @param {{maxMessages?: number, maxChars?: number}} [limits]
 */
export function cleanChatMessages(input, limits = {}) {
  const maxMessages = limits.maxMessages ?? 20;
  const maxChars = limits.maxChars ?? 8000;
  if (!Array.isArray(input)) return [];
  /** @type {Array<{role: "user" | "assistant", content: string}>} */
  const out = [];
  for (const m of input) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (typeof m.content !== "string" || !m.content.trim()) continue;
    out.push({ role: m.role, content: m.content.slice(0, maxChars) });
  }
  return out.slice(-maxMessages);
}

/** Plain words for the chat bubble. @param {any} err */
function friendlyChatError(err) {
  const code = err?.code;
  if (code === "app_limit_reached") {
    return "This app used its AI limit for this month. Raise it in Uno Work → Settings → Apps.";
  }
  if (code === "ai_not_connected")
    return "AI isn't connected on this computer — sign in to Uno in Uno Work.";
  if (
    code === "provider_unreachable" ||
    code === "no_model" ||
    code === "provider_not_configured"
  ) {
    return String(err.message);
  }
  if (code === "unreachable" || code === "no_token") {
    return "This app can't reach the computer's AI right now.";
  }
  return String(err?.message || "The AI couldn't answer.");
}

/** @param {any} res @param {number} status @param {string} message */
function endJson(res, status, message) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: { message } }));
}

/** @param {any} req @param {number} max @returns {Promise<string>} */
function readRequest(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {any[]} */
    const chunks = [];
    req.on("data", (/** @type {any} */ chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new Error("too large"));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** @type {Promise<string | null> | null} */
let componentPromise = null;
/**
 * The browser component (uno-chat.js) as text: next to this file, else the
 * copy the daemon keeps in ~/.uno/sdk/js/. Null when neither is there.
 * @returns {Promise<string | null>}
 */
export function chatComponentSource() {
  if (!componentPromise) {
    componentPromise = (async () => {
      const node = await nodeBuiltins();
      if (!node) return null;
      const candidates = [];
      try {
        const { fileURLToPath } = await import("node:url");
        candidates.push(
          node.path.join(node.path.dirname(fileURLToPath(import.meta.url)), "uno-chat.js"),
        );
      } catch {
        // not a file: URL (bundled)
      }
      candidates.push(node.path.join(node.os.homedir(), ".uno", "sdk", "js", "uno-chat.js"));
      for (const file of candidates) {
        try {
          return await node.fs.promises.readFile(file, "utf8");
        } catch {
          // next
        }
      }
      return null;
    })();
    componentPromise.then((v) => {
      if (v === null) componentPromise = null;
    });
  }
  return componentPromise;
}

const DEFAULT_TYPE = "application/octet-stream";
/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  html: "text/html; charset=utf-8",
  json: "application/json",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Content-Type from a file name (what the browser gets back on download). */
export function guessContentType(/** @type {string} */ name) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return CONTENT_TYPES[ext] || DEFAULT_TYPE;
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
/** A handler for `<uno-chat>` on the default client — see createClient().chatHandler. */
export const chatHandler = (/** @type {ChatHandlerOptions} */ opts) => client().chatHandler(opts);
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
/** @type {any} */
export const notify = (input, opts) => client().notify(input, opts);
/** The app's folder in the account's cloud (needs "storage" in the manifest). */
export const storage = /** @type {any} */ (
  new Proxy(
    {},
    {
      get: (_target, name) => /** @type {any} */ (client().storage)[name],
    },
  )
);
