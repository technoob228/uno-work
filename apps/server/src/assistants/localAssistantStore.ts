/**
 * What the daemon keeps about the assistants that live on THIS computer
 * (decision 02.10 evening: "by default — right here", several assistants per
 * computer, a computer of its own is an option):
 *
 * - which apps each assistant may open (`none` / `read` / `write` per
 *   connector) — checked by Work on every connector call, because on a
 *   shared computer the console sees one machine token for all assistants
 *   and cannot tell them apart (see {@link connectorAccessDecision});
 * - which assistant started which chat (`create_thread` with the assistant's
 *   own token) — for "Chats Ana started" and for the access check of chats
 *   an assistant started;
 * - deleted assistants, kept 7 days with Restore (the same promise as an
 *   assistant on its own computer).
 *
 * Files live under the daemon's state dir, not in the assistant's folder:
 * the assistant reads and writes its own folder all day. That makes them
 * a guard against mistakes, not against a determined attacker on the same
 * computer — an assistant on its own computer is the real boundary, and the
 * UI says so.
 *
 * Plain async I/O with a per-file write queue; no Effect, so the pure parts
 * are unit-tested directly.
 *
 * @module assistants/localAssistantStore
 */
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

import {
  ASSISTANT_PROJECT_ID,
  isAssistantProjectId,
  type AssistantAppLevel,
} from "@t3tools/contracts";

/** How long a deleted assistant is kept (same as an assistant computer). */
export const DELETED_ASSISTANT_KEEP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** The started-chats ledger keeps this many newest entries. */
const LEDGER_LIMIT = 2_000;

const storeDir = (stateDir: string) => nodePath.join(stateDir, "assistants");

// ── Serialized JSON files ─────────────────────────────────────────────

const queues = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task on the same file. */
function serialized<A>(file: string, task: () => Promise<A>): Promise<A> {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    file,
    next.catch(() => undefined),
  );
  return next;
}

async function readJson<A>(file: string, fallback: A): Promise<A> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as A;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(nodePath.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, file);
}

function updateJson<A>(file: string, fallback: A, update: (current: A) => A): Promise<A> {
  return serialized(file, async () => {
    const next = update(await readJson(file, fallback));
    await writeJson(file, next);
    return next;
  });
}

// ── Apps an assistant may open ────────────────────────────────────────

export interface AppAccess {
  /** Per connector provider (`gmail`, `google-drive`, `notion`, `github`, …). */
  readonly permissions: Readonly<Record<string, AssistantAppLevel>>;
  /** False until the person set anything: everything is allowed then. */
  readonly restricted: boolean;
}

const appsFile = (stateDir: string, projectId: string) =>
  nodePath.join(storeDir(stateDir), encodeURIComponent(projectId), "apps.json");

const LEVELS: ReadonlySet<string> = new Set(["none", "read", "write"]);

export function normalizePermissions(raw: unknown): Record<string, AssistantAppLevel> {
  const out: Record<string, AssistantAppLevel> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [provider, level] of Object.entries(raw as Record<string, unknown>)) {
    if (
      /^[a-z0-9][a-z0-9-]{0,40}$/.test(provider) &&
      typeof level === "string" &&
      LEVELS.has(level)
    ) {
      out[provider] = level as AssistantAppLevel;
    }
  }
  return out;
}

export async function readAppAccess(stateDir: string, projectId: string): Promise<AppAccess> {
  const stored = await readJson<{ permissions?: unknown } | null>(
    appsFile(stateDir, projectId),
    null,
  );
  if (stored === null) return { permissions: {}, restricted: false };
  return { permissions: normalizePermissions(stored.permissions), restricted: true };
}

export async function writeAppAccess(
  stateDir: string,
  projectId: string,
  permissions: Readonly<Record<string, AssistantAppLevel>>,
): Promise<AppAccess> {
  const normalized = normalizePermissions(permissions);
  await serialized(appsFile(stateDir, projectId), () =>
    writeJson(appsFile(stateDir, projectId), { permissions: normalized }),
  );
  return { permissions: normalized, restricted: true };
}

/**
 * One connector call by a chat that belongs to an assistant: allowed, or why
 * not. A provider the person never set is allowed ("full access by default",
 * decision 02.10); `read` lets only the tools that change nothing through.
 */
export function connectorAccessDecision(
  access: AppAccess,
  provider: string,
  toolChangesThings: boolean,
): "allow" | "none" | "read-only" {
  if (!access.restricted) return "allow";
  const level = access.permissions[provider] ?? "write";
  if (level === "none") return "none";
  if (level === "read" && toolChangesThings) return "read-only";
  return "allow";
}

// ── Which assistant started which chat ────────────────────────────────

const ledgerFile = (stateDir: string) => nodePath.join(storeDir(stateDir), "started-chats.json");

type Ledger = Record<string, { readonly assistant: string; readonly at: string }>;

export function recordStartedChat(
  stateDir: string,
  threadId: string,
  assistantProjectId: string,
  now: Date = new Date(),
): Promise<void> {
  return updateJson<Ledger>(ledgerFile(stateDir), {}, (current) => {
    const next: Ledger = {
      ...current,
      [threadId]: { assistant: assistantProjectId, at: now.toISOString() },
    };
    const entries = Object.entries(next);
    if (entries.length <= LEDGER_LIMIT) return next;
    return Object.fromEntries(
      entries.toSorted((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, LEDGER_LIMIT),
    );
  }).then(() => undefined);
}

export async function readStartedChats(stateDir: string): Promise<ReadonlyMap<string, string>> {
  const ledger = await readJson<Ledger>(ledgerFile(stateDir), {});
  return new Map(
    Object.entries(ledger).flatMap(([threadId, entry]) =>
      typeof entry?.assistant === "string" ? [[threadId, entry.assistant] as const] : [],
    ),
  );
}

export interface OwnedThread {
  readonly id: string;
  readonly projectId: string;
  readonly spawnedByThreadId?: string | null | undefined;
  readonly assistantRole?: "chat" | "spawned" | null | undefined;
}

/**
 * The assistant a chat belongs to, or null for the person's own chats:
 *
 * - a chat in an assistant's workspace (its conversations, Telegram chats);
 * - a chat an assistant started with `create_thread` (the ledger; before the
 *   ledger existed only the default assistant could start chats);
 * - a chat an assistant's chat started with `chat_create` (its parent), so an
 *   assistant cannot reach a forbidden app by starting another chat.
 */
export function owningAssistant(
  thread: OwnedThread,
  threadById: (id: string) => OwnedThread | undefined,
  startedBy: ReadonlyMap<string, string>,
): string | null {
  let current: OwnedThread | undefined = thread;
  for (let depth = 0; current !== undefined && depth < 6; depth += 1) {
    if (isAssistantProjectId(current.projectId)) return current.projectId;
    const ledger = startedBy.get(current.id);
    if (ledger !== undefined) return ledger;
    if (current.assistantRole === "spawned") return ASSISTANT_PROJECT_ID;
    const parent: string | null = current.spawnedByThreadId ?? null;
    current = parent === null ? undefined : threadById(parent);
  }
  return null;
}

// ── Deleted assistants (kept 7 days) ──────────────────────────────────

export interface DeletedAssistantRecord {
  readonly projectId: string;
  readonly title: string;
  readonly emoji: string | null;
  readonly deletedAt: string;
  /** Where its folder was. */
  readonly workspaceRoot: string;
  /** Where its folder is kept until it is purged. */
  readonly trashPath: string;
  /** What to put back on Restore. */
  readonly connectorRows: ReadonlyArray<{ readonly kind: string; readonly config: unknown }>;
  readonly bindings: ReadonlyArray<unknown>;
  readonly archivedThreadIds: ReadonlyArray<string>;
}

const deletedFile = (stateDir: string) => nodePath.join(storeDir(stateDir), "deleted.json");

export async function readDeletedAssistants(
  stateDir: string,
): Promise<ReadonlyArray<DeletedAssistantRecord>> {
  const records = await readJson<Record<string, DeletedAssistantRecord>>(deletedFile(stateDir), {});
  return Object.values(records).filter(
    (record) => typeof record?.projectId === "string" && typeof record.trashPath === "string",
  );
}

export function putDeletedAssistant(
  stateDir: string,
  record: DeletedAssistantRecord,
): Promise<void> {
  return updateJson<Record<string, DeletedAssistantRecord>>(
    deletedFile(stateDir),
    {},
    (current) => ({
      ...current,
      [record.projectId]: record,
    }),
  ).then(() => undefined);
}

export function dropDeletedAssistant(stateDir: string, projectId: string): Promise<void> {
  return updateJson<Record<string, DeletedAssistantRecord>>(
    deletedFile(stateDir),
    {},
    (current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    },
  ).then(() => undefined);
}

export function keepUntil(deletedAt: string): string {
  return new Date(Date.parse(deletedAt) + DELETED_ASSISTANT_KEEP_DAYS * DAY_MS).toISOString();
}

export function isPastKeep(record: Pick<DeletedAssistantRecord, "deletedAt">, now: Date): boolean {
  return now.getTime() >= Date.parse(keepUntil(record.deletedAt));
}

/** A free path for `folder` inside `trashDir` (the same name deleted twice gets a suffix). */
export async function freeTrashPath(
  trashDir: string,
  folderName: string,
  now: Date,
): Promise<string> {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const candidate = nodePath.join(trashDir, `${folderName}__${stamp}`);
  try {
    await fsp.access(candidate);
    return nodePath.join(
      trashDir,
      `${folderName}__${stamp}-${Math.random().toString(16).slice(2, 6)}`,
    );
  } catch {
    return candidate;
  }
}

// ── Profile (emoji, template) ─────────────────────────────────────────

export interface AssistantProfileFile {
  readonly emoji: string | null;
  readonly template: string | null;
  readonly createdAt: string | null;
}

/** `.uno/profile.json` in the assistant's folder: what "New assistant" picked. */
export const profilePath = (workspaceRoot: string) =>
  nodePath.join(workspaceRoot, ".uno", "profile.json");

/** A short trimmed string, or null. */
const profileText = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, max) : null;

export async function readProfile(workspaceRoot: string): Promise<AssistantProfileFile | null> {
  const raw = await readJson<Partial<AssistantProfileFile> | null>(
    profilePath(workspaceRoot),
    null,
  );
  if (raw === null) return null;
  return {
    emoji: profileText(raw.emoji, 16),
    template: profileText(raw.template, 40),
    createdAt: profileText(raw.createdAt, 40),
  };
}

export function writeProfile(workspaceRoot: string, profile: AssistantProfileFile): Promise<void> {
  return serialized(profilePath(workspaceRoot), () =>
    writeJson(profilePath(workspaceRoot), profile),
  );
}
