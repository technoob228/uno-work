/**
 * Uno Spark as the `spark_*` tools see it: one JavaScript or Python file that
 * answers HTTPS at `https://<name>.spark.uno4.me/`, no server, free.
 *
 * The Spark gateway (`https://api.spark.uno4.me/v1`) takes ONLY a token
 * limited to Spark (`uno_…` with spark:* scopes) — not this computer's
 * machine token and not the account key. The daemon gets one from the console
 * (`POST /api/v1/spark/token`, 30 days) with the same credential the other
 * console tools use (`consoleToken`: the machine token on a Work computer,
 * the account key a person put in Settings on a laptop), keeps it in the
 * secret store (0600, never in settings.json) and mints a new one when it
 * nears its end, when the credential changes, or when the gateway answers 401.
 *
 * Neither token ever reaches the agent, a tool result or a log line.
 *
 * @module unoWork/sparkClient
 */
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import { gzipSync } from "node:zlib";

import { collectSiteFiles, type SiteSkip } from "../files/sitePublish.ts";
import { registerKnownSecret } from "../secretRedaction.ts";

export const SPARK_API_BASE = "https://api.spark.uno4.me/v1";
export const SPARK_TOKEN_PATH = "/api/v1/spark/token";
/** Where a Spark app answers. Only a fallback: the gateway's own `url` wins. */
export const SPARK_APPS_DOMAIN = "spark.uno4.me";
/** Name rule of the gateway: 3–32 of a-z0-9-, starting with a letter. */
export const SPARK_NAME_PATTERN = "^[a-z][a-z0-9-]{2,31}$";

/** A token this close to its end is replaced before use. */
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
const MINT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;

/** One credential the console accepts was not there: the tools explain it. */
export const SPARK_NOT_LINKED_MESSAGE =
  "Spark needs this computer to be connected to the person's Uno account: tell them to connect this computer to their Uno account (Settings → Uno account), then try again.";

export class SparkError extends Error {
  readonly code: string;
  constructor(message: string, code = "") {
    super(message);
    this.name = "SparkError";
    this.code = code;
  }
}

export function sparkAppUrl(name: string, fromGateway?: unknown): string {
  if (typeof fromGateway === "string" && /^https:\/\/[a-z0-9.-]+(\/|$)/i.test(fromGateway)) {
    return fromGateway.endsWith("/") ? fromGateway : `${fromGateway}/`;
  }
  return `https://${name}.${SPARK_APPS_DOMAIN}/`;
}

// ── Token ──────────────────────────────────────────────────────────────

export interface StoredSparkToken {
  readonly token: string;
  readonly expiresAt: string | null;
  readonly api: string;
  /** Fingerprint of the console credential it was minted with. */
  readonly mintedBy: string;
}

/** Where the token is kept between calls (the daemon's secret store). */
export interface SparkTokenCache {
  readonly read: () => Promise<StoredSparkToken | null>;
  readonly write: (token: StoredSparkToken | null) => Promise<void>;
}

export function parseStoredSparkToken(bytes: Uint8Array | null): StoredSparkToken | null {
  if (bytes === null || bytes.length === 0) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<StoredSparkToken>;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    if (typeof parsed.mintedBy !== "string" || typeof parsed.api !== "string") return null;
    return {
      token: parsed.token,
      expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : null,
      api: parsed.api,
      mintedBy: parsed.mintedBy,
    };
  } catch {
    return null;
  }
}

export function memorySparkTokenCache(): SparkTokenCache {
  let current: StoredSparkToken | null = null;
  return {
    read: async () => current,
    write: async (token) => {
      current = token;
    },
  };
}

/** Never the credential itself: a short hash, to notice it changed. */
export function credentialFingerprint(credential: string): string {
  return createHash("sha256").update(credential.trim()).digest("hex").slice(0, 16);
}

/** The gateway address the console names, if it is an https Uno address; else the default. */
function trustedApiBase(value: unknown): string {
  if (typeof value !== "string") return SPARK_API_BASE;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const uno = host === "uno4.me" || host.endsWith(".uno4.me") || host.endsWith(".uno4.dev");
    return url.protocol === "https:" && uno ? value.replace(/\/+$/, "") : SPARK_API_BASE;
  } catch {
    return SPARK_API_BASE;
  }
}

/** `{"error": code, "detail"|"message": …}` or a plain-text answer. */
export function errorParts(status: number, text: string): { code: string; detail: string } {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const code = typeof body.error === "string" ? body.error : "";
    const detail =
      typeof body.detail === "string"
        ? body.detail
        : typeof body.message === "string"
          ? body.message
          : "";
    return { code, detail };
  } catch {
    return { code: "", detail: text.trim().slice(0, 300) || `HTTP ${status}` };
  }
}

/** The console's refusal to mint a Spark token, as a sentence the agent can act on. */
export function sparkTokenErrorMessage(status: number, text: string): string {
  const { code, detail } = errorParts(status, text);
  switch (true) {
    case status === 401:
      return `The Uno console didn't accept this computer's sign-in. ${SPARK_NOT_LINKED_MESSAGE}`;
    case code === "SPARK_UNAVAILABLE" || code === "SPARK_OFF":
      return "Spark isn't switched on for this Uno account yet. Tell the person in one line; meanwhile run it as an app on this computer (uno_guide apps) or, for bots and APIs for others, on an app server (uno_guide app-servers).";
    case code === "ACCOUNT_NOT_CLAIMED":
      return "This Uno account isn't claimed yet, and Spark needs a claimed account. Tell the person to finish setting up their account in the Uno console (console.uno.place, the claim step in Telegram), then try again.";
    case code === "ACCOUNT_DISABLED":
      return "This Uno account is disabled, so Spark can't be used. Tell the person to write to Uno support.";
    case code === "SPARK_TOKEN_CALLER":
      return `This computer's Uno access can't get a Spark token${detail ? ` (${detail})` : ""}. On a cloud computer the person reopens Uno Work from the Uno console to refresh its access; on a laptop they put the account key in Settings → Uno account. Don't try another way.`;
    case status === 404:
      return "The Uno console doesn't hand out Spark tokens yet. Tell the person Spark isn't available from Uno Work yet; don't try another way.";
  }
  return `Couldn't get Spark access from the Uno console: ${[code, detail].filter(Boolean).join(" — ") || `HTTP ${status}`}.`;
}

export interface SparkRequest {
  readonly method: "GET" | "PUT" | "DELETE";
  /** `/apps/<name>…` — relative to the gateway base (`…/v1`). */
  readonly path: string;
  /** Raw body (code, a .tar.gz) … */
  readonly body?: Uint8Array;
  readonly contentType?: string;
  /** … or JSON. */
  readonly json?: unknown;
  readonly timeoutMs?: number;
}

export interface SparkReply {
  readonly status: number;
  /** Parsed JSON when the gateway answered JSON, else null. */
  readonly json: unknown;
  /** The body as text (compiler errors, plain logs). */
  readonly text: string;
  /** `X-Uno-Spark-Error`, when over a limit. */
  readonly sparkError: string | null;
}

export interface SparkClient {
  readonly request: (input: SparkRequest) => Promise<SparkReply>;
}

/**
 * A client that mints, caches and renews the Spark token by itself. A 401
 * from the gateway (revoked or expired early) re-mints once and retries.
 */
export function makeSparkClient(input: {
  /** The console credential (`consoleToken`), "" when this computer isn't linked. */
  readonly credential: () => Promise<string>;
  readonly consoleBaseUrl: string;
  readonly cache: SparkTokenCache;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}): SparkClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;

  const mint = async (credential: string): Promise<StoredSparkToken> => {
    const response = await fetchImpl(`${input.consoleBaseUrl}${SPARK_TOKEN_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      const { code } = errorParts(response.status, text);
      throw new SparkError(sparkTokenErrorMessage(response.status, text), code);
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // handled below
    }
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (token.length === 0) {
      throw new SparkError("The Uno console answered without a Spark token. Try again later.");
    }
    registerKnownSecret(token);
    const stored: StoredSparkToken = {
      token,
      expiresAt: typeof body.expires_at === "string" ? body.expires_at : null,
      api: trustedApiBase(body.api),
      mintedBy: credentialFingerprint(credential),
    };
    await input.cache.write(stored).catch(() => undefined);
    return stored;
  };

  const usable = (stored: StoredSparkToken | null, credential: string): boolean => {
    if (stored === null || stored.mintedBy !== credentialFingerprint(credential)) return false;
    if (stored.expiresAt === null) return true;
    const ends = Date.parse(stored.expiresAt);
    return Number.isFinite(ends) && ends - now() > RENEW_BEFORE_MS;
  };

  const token = async (credential: string, fresh: boolean): Promise<StoredSparkToken> => {
    if (!fresh) {
      const stored = await input.cache.read().catch(() => null);
      if (usable(stored, credential)) {
        registerKnownSecret(stored!.token);
        return stored!;
      }
    }
    return mint(credential);
  };

  const send = async (stored: StoredSparkToken, request: SparkRequest): Promise<SparkReply> => {
    const headers: Record<string, string> = { authorization: `Bearer ${stored.token}` };
    let body: Uint8Array | string | undefined;
    if (request.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(request.json);
    } else if (request.body !== undefined) {
      headers["content-type"] = request.contentType ?? "application/octet-stream";
      body = request.body;
    }
    const response = await fetchImpl(`${stored.api}${request.path}`, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body: body as NonNullable<RequestInit["body"]> } : {}),
      signal: AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      status: response.status,
      json,
      text,
      sparkError: response.headers.get("x-uno-spark-error"),
    };
  };

  return {
    request: async (request) => {
      const credential = (await input.credential()).trim();
      if (credential.length === 0) throw new SparkError(SPARK_NOT_LINKED_MESSAGE, "NOT_LINKED");
      const first = await send(await token(credential, false), request);
      if (first.status !== 401) return first;
      // Revoked or expired early: one new token, one retry.
      await input.cache.write(null).catch(() => undefined);
      return send(await token(credential, true), request);
    },
  };
}

// ── What goes up ───────────────────────────────────────────────────────

export type SparkType = "js" | "python";

/** Spark takes a small program: code, not data or packages. */
export const SPARK_MAX_FILES = 300;
export const SPARK_MAX_BYTES = 10 * 1024 * 1024;

export function sparkTypeOf(fileName: string): SparkType | null {
  const ext = nodePath.extname(fileName).toLowerCase();
  if (ext === ".js" || ext === ".mjs") return "js";
  if (ext === ".py") return "python";
  return null;
}

const ENTRY_GUESSES: Record<SparkType, ReadonlyArray<string>> = {
  js: ["index.js", "main.js", "worker.js", "app.js", "bot.js", "src/index.js", "index.mjs"],
  python: ["main.py", "app.py", "bot.py", "index.py", "src/main.py"],
};

export function guessSparkEntry(
  files: ReadonlyArray<string>,
  type: SparkType | undefined,
): string | null {
  const set = new Set(files);
  for (const kind of type ? [type] : (["js", "python"] as const)) {
    for (const candidate of ENTRY_GUESSES[kind]) if (set.has(candidate)) return candidate;
  }
  return null;
}

export interface PackedSparkFolder {
  readonly bytes: Uint8Array;
  readonly files: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<SiteSkip>;
}

/** A ustar header field: text, zero-padded to `length`. */
function writeField(header: Buffer, offset: number, length: number, value: string): void {
  header.write(value, offset, Math.min(Buffer.byteLength(value), length), "utf8");
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function ustarHeader(relativePath: string, size: number): Buffer {
  let name = relativePath;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = relativePath.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(relativePath.slice(cut + 1)) > 100) {
      throw new SparkError(`The path ${relativePath} is too long to pack.`);
    }
    prefix = relativePath.slice(0, cut);
    name = relativePath.slice(cut + 1);
  }
  const header = Buffer.alloc(512, 0);
  writeField(header, 0, 100, name);
  writeField(header, 100, 8, octal(0o644, 8));
  writeField(header, 108, 8, octal(0, 8));
  writeField(header, 116, 8, octal(0, 8));
  writeField(header, 124, 12, octal(size, 12));
  writeField(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156); // checksum counts as spaces
  writeField(header, 156, 1, "0");
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  writeField(header, 345, 155, prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeField(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/**
 * The folder as a `.tar.gz`, the way a site is collected: no dotfiles
 * (`.env`, `.git`, `.venv`), no key files, no `node_modules`/`venv`/
 * `__pycache__`, no links. What stayed behind is in `skipped`.
 */
export async function packSparkFolder(folder: string): Promise<PackedSparkFolder> {
  const skipped: SiteSkip[] = [];
  const files = await collectSiteFiles(folder, skipped, {
    maxFiles: SPARK_MAX_FILES,
    maxBytes: SPARK_MAX_BYTES,
    tooManyMessage: `This folder has more than ${SPARK_MAX_FILES} files — Spark takes a small program, not data or packages.`,
    tooBigMessage:
      "This folder is bigger than 10 MB — Spark takes a small program, not data or packages.",
  });
  const chunks: Buffer[] = [];
  for (const file of files) {
    const bytes = await fsPromises.readFile(file.absolutePath);
    chunks.push(ustarHeader(file.relativePath, bytes.byteLength), bytes);
    const pad = (512 - (bytes.byteLength % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return {
    bytes: new Uint8Array(gzipSync(Buffer.concat(chunks))),
    files: files.map((file) => file.relativePath),
    skipped,
  };
}

// ── Secrets from the project's .env ────────────────────────────────────

/** The value of `name` in a dotenv text (last active line wins), or null. */
export function readEnvValue(text: string, name: string): string | null {
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== name) continue;
    let value = (match[2] ?? "").trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      // The double-quote dialect `formatEnvValue` writes (secretsEnv.ts).
      value = value
        .slice(1, -1)
        .replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char === "r" ? "\r" : char));
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    found = value;
  }
  return found !== null && found.length > 0 ? found : null;
}
