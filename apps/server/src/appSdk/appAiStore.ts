/**
 * What the daemon remembers about apps that use the machine's AI: a hash of
 * each app's token, what it spent, its limit and how much its tasks may do on
 * their own. One small JSON file in the daemon's state dir (0600), written
 * atomically; the token itself lives only in the app's key folder
 * (`appKeys.ts`) and in the app's environment.
 *
 * Spending is kept when an app's manifest disappears: removing and re-adding
 * a manifest must not reset the limit.
 */
import {
  APP_TASK_TOOLS_DEFAULT_CAP,
  APP_TASK_TOOLS_ORDER,
  type AppTaskTools,
} from "@t3tools/contracts";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const APP_TOKEN_PREFIX = "uno_app_";
/** Tasks remembered per app (the rest is in Work's own thread history). */
const MAX_TASKS_PER_APP = 50;

export interface StoredAppTask {
  readonly id: string;
  readonly threadId: string;
  readonly createdAt: string;
  readonly tools: AppTaskTools;
  readonly harness: string;
  readonly turnCountAtStart: number;
}

export interface StoredApp {
  readonly id: string;
  tokenHash: string | null;
  tokenIssuedAt: string | null;
  spentUsd: number;
  requests: number;
  tasksStarted: number;
  lastUsedAt: string | null;
  /** Set by the person in Settings → Apps; null = the manifest's limit. */
  limitOverrideUsd: number | null;
  revoked: boolean;
  taskToolsCap: AppTaskTools;
  tasks: StoredAppTask[];
}

interface StoreFile {
  readonly version: 1;
  readonly apps: Record<string, StoredApp>;
}

export function hashAppToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newAppToken(): string {
  return `${APP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function money(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeApp(id: string, raw: unknown): StoredApp {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const cap = r["taskToolsCap"];
  return {
    id,
    tokenHash: typeof r["tokenHash"] === "string" ? r["tokenHash"] : null,
    tokenIssuedAt: typeof r["tokenIssuedAt"] === "string" ? r["tokenIssuedAt"] : null,
    spentUsd: money(r["spentUsd"]),
    requests: money(r["requests"]),
    tasksStarted: money(r["tasksStarted"]),
    lastUsedAt: typeof r["lastUsedAt"] === "string" ? r["lastUsedAt"] : null,
    limitOverrideUsd:
      typeof r["limitOverrideUsd"] === "number" && r["limitOverrideUsd"] >= 0
        ? r["limitOverrideUsd"]
        : null,
    revoked: r["revoked"] === true,
    taskToolsCap: APP_TASK_TOOLS_ORDER.includes(cap as AppTaskTools)
      ? (cap as AppTaskTools)
      : APP_TASK_TOOLS_DEFAULT_CAP,
    tasks: Array.isArray(r["tasks"])
      ? (r["tasks"] as StoredAppTask[]).filter(
          (t) => typeof t?.id === "string" && typeof t?.threadId === "string",
        )
      : [],
  };
}

export function emptyStoredApp(id: string): StoredApp {
  return normalizeApp(id, {});
}

export interface AppAiStore {
  readonly get: (id: string) => StoredApp | undefined;
  readonly all: () => ReadonlyArray<StoredApp>;
  readonly ensure: (id: string) => StoredApp;
  readonly findByTokenHash: (hash: string) => StoredApp | undefined;
  /** Mutate one app and persist. */
  readonly update: (id: string, change: (app: StoredApp) => void) => Promise<StoredApp>;
  readonly addSpend: (id: string, usd: number) => Promise<void>;
  readonly addTask: (id: string, task: StoredAppTask) => Promise<void>;
  readonly flush: () => Promise<void>;
}

/** Loads the store (a missing or broken file is an empty store, never a crash). */
export async function openAppAiStore(filePath: string): Promise<AppAiStore> {
  const apps = new Map<string, StoredApp>();
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<StoreFile>;
    for (const [id, raw] of Object.entries(parsed.apps ?? {})) apps.set(id, normalizeApp(id, raw));
  } catch {
    // First start, or a corrupt file: start empty (tokens are re-issued on sync).
  }

  let writing: Promise<void> = Promise.resolve();
  let dirty = false;
  const persist = () => {
    dirty = true;
    writing = writing.then(async () => {
      if (!dirty) return;
      dirty = false;
      const body: StoreFile = { version: 1, apps: Object.fromEntries(apps) };
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, filePath);
    });
    return writing.catch(() => undefined);
  };

  const ensure = (id: string) => {
    let app = apps.get(id);
    if (!app) {
      app = emptyStoredApp(id);
      apps.set(id, app);
    }
    return app;
  };

  return {
    get: (id) => apps.get(id),
    all: () => [...apps.values()],
    ensure,
    findByTokenHash: (hash) => {
      for (const app of apps.values()) if (app.tokenHash === hash) return app;
      return undefined;
    },
    update: async (id, change) => {
      const app = ensure(id);
      change(app);
      await persist();
      return app;
    },
    addSpend: async (id, usd) => {
      const app = ensure(id);
      app.spentUsd = Math.round((app.spentUsd + Math.max(0, usd)) * 1e6) / 1e6;
      app.requests += 1;
      app.lastUsedAt = new Date().toISOString();
      await persist();
    },
    addTask: async (id, task) => {
      const app = ensure(id);
      app.tasks = [task, ...app.tasks].slice(0, MAX_TASKS_PER_APP);
      app.tasksStarted += 1;
      app.lastUsedAt = task.createdAt;
      await persist();
    },
    flush: () => persist(),
  };
}
