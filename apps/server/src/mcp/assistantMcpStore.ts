/**
 * "Your own tool" for ONE assistant (assistants D, item 11 "Tasks", 28.10):
 * remote MCP servers the person gave to this assistant, by address. Its chats
 * get them on top of the computer's own (`settings.mcpServers`) — and, unlike
 * those, also in the sandbox: the person handed this server to this assistant
 * (the owner's servers stay out of a sandboxed chat, 952aedc09d).
 *
 * Kept by the daemon next to the assistant's app levels, under the state dir
 * (`<stateDir>/assistants/<projectId>/mcp.json`, 0600), not in the
 * assistant's folder: the assistant writes its own folder all day and must
 * not hand itself servers. An address may carry the server's key
 * (`…/mcp/s/<key>/…`), so addresses never go to logs and the API shows them
 * masked.
 *
 * Plain async I/O, no Effect: the pure parts are unit-tested directly.
 *
 * @module mcp/assistantMcpStore
 */
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

import {
  MAX_UNO_MCP_SERVERS,
  UNO_MCP_SERVER_NAME_PATTERN,
  type UnoMcpServer,
} from "@t3tools/contracts";

import { UNO_WORK_MCP_SERVER_NAME } from "../unoWork/constants.ts";

/** One server of an assistant: the same shape as the computer's own. */
export type AssistantMcpServer = UnoMcpServer;

/** What the API shows: the address masked down to its host (it may carry a key). */
export interface AssistantMcpServerView {
  readonly name: string;
  readonly host: string;
  readonly enabled: boolean;
}

export const assistantMcpFile = (stateDir: string, projectId: string): string =>
  nodePath.join(stateDir, "assistants", encodeURIComponent(projectId), "mcp.json");

function validUrl(raw: string): string | null {
  const url = raw.trim();
  if (url.length < 8 || url.length > 2048) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Junk dropped, names unique, the built-in name refused, at most 20. */
export function normalizeAssistantMcpServers(raw: unknown): ReadonlyArray<AssistantMcpServer> {
  const list =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { servers?: unknown }).servers
      : raw;
  if (!Array.isArray(list)) return [];
  const out: AssistantMcpServer[] = [];
  const names = new Set<string>();
  for (const entry of list) {
    if (out.length >= MAX_UNO_MCP_SERVERS) break;
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const url = typeof record.url === "string" ? validUrl(record.url) : null;
    if (!UNO_MCP_SERVER_NAME_PATTERN.test(name) || name === UNO_WORK_MCP_SERVER_NAME) continue;
    if (url === null || names.has(name)) continue;
    names.add(name);
    out.push({ name, url, enabled: record.enabled !== false });
  }
  return out;
}

/** `https://mcp.example.com/mcp/s/KEY` → `mcp.example.com`. */
export function mcpServerHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function toAssistantMcpView(server: AssistantMcpServer): AssistantMcpServerView {
  return { name: server.name, host: mcpServerHost(server.url), enabled: server.enabled };
}

/** A short name from the address (`mcp.context7.com` → `context7`), free among `taken`. */
export function assistantMcpNameFromUrl(url: string, taken: ReadonlyArray<string>): string | null {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    host = parsed.hostname;
  } catch {
    return null;
  }
  const labels = host
    .toLowerCase()
    .split(".")
    .filter((label) => label && !["mcp", "www", "api"].includes(label));
  const base =
    (labels.length > 1 ? labels[labels.length - 2] : labels[0])
      ?.replace(/[^a-z0-9_-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 40) || "tool";
  const first = UNO_MCP_SERVER_NAME_PATTERN.test(base) && base !== UNO_WORK_MCP_SERVER_NAME;
  let name = first ? base : "tool";
  for (let n = 2; taken.includes(name); n += 1) name = `${first ? base : "tool"}-${n}`.slice(0, 48);
  return name;
}

export type AddAssistantMcpResult =
  | {
      readonly ok: true;
      readonly servers: ReadonlyArray<AssistantMcpServer>;
      readonly name: string;
    }
  | {
      readonly ok: false;
      readonly code: "invalid_url" | "duplicate" | "too_many" | "invalid_name";
    };

/** Adds one server (name from the address unless given). Pure. */
export function addAssistantMcpServer(
  current: ReadonlyArray<AssistantMcpServer>,
  input: { readonly url: string; readonly name?: string | undefined },
): AddAssistantMcpResult {
  const url = validUrl(input.url);
  if (url === null) return { ok: false, code: "invalid_url" };
  if (current.some((server) => server.url === url)) return { ok: false, code: "duplicate" };
  if (current.length >= MAX_UNO_MCP_SERVERS) return { ok: false, code: "too_many" };
  const taken = current.map((server) => server.name);
  const wanted = input.name?.trim();
  let name: string | null;
  if (wanted) {
    if (!UNO_MCP_SERVER_NAME_PATTERN.test(wanted) || wanted === UNO_WORK_MCP_SERVER_NAME) {
      return { ok: false, code: "invalid_name" };
    }
    if (taken.includes(wanted)) return { ok: false, code: "duplicate" };
    name = wanted;
  } else {
    name = assistantMcpNameFromUrl(url, taken);
  }
  if (name === null) return { ok: false, code: "invalid_url" };
  return { ok: true, name, servers: [...current, { name, url, enabled: true }] };
}

export async function readAssistantMcpServers(
  stateDir: string,
  projectId: string,
): Promise<ReadonlyArray<AssistantMcpServer>> {
  try {
    const text = await fsp.readFile(assistantMcpFile(stateDir, projectId), "utf8");
    return normalizeAssistantMcpServers(JSON.parse(text));
  } catch {
    return [];
  }
}

const queues = new Map<string, Promise<unknown>>();

/** Read-modify-write of one assistant's list, one at a time per file. 0600: addresses may carry keys. */
export function updateAssistantMcpServers<A>(
  stateDir: string,
  projectId: string,
  update: (current: ReadonlyArray<AssistantMcpServer>) => {
    readonly servers: ReadonlyArray<AssistantMcpServer> | null;
    readonly result: A;
  },
): Promise<A> {
  const file = assistantMcpFile(stateDir, projectId);
  const previous = queues.get(file) ?? Promise.resolve();
  const task = async () => {
    const { servers, result } = update(await readAssistantMcpServers(stateDir, projectId));
    if (servers !== null) {
      await fsp.mkdir(nodePath.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(temporary, `${JSON.stringify({ servers }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await fsp.rename(temporary, file);
    }
    return result;
  };
  const next = previous.then(task, task);
  queues.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}
