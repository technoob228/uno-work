/**
 * What the daemon remembers about apps that use the machine's AI: a hash of
 * each app's token, what it spent, its limit and how much its tasks may do on
 * their own. One small JSON file in the daemon's state dir (0600), written
 * atomically; the token itself lives only in the app's key folder
 * (`appKeys.ts`) and in the app's environment.
 *
 * Spending is kept when an app's manifest disappears: removing and re-adding
 * a manifest must not reset the limit.
 *
 * The limit is monthly: on the 1st (UTC) the month's spending (chat + tasks)
 * moves into a lifetime total and the month starts from zero — like a plan's
 * boost hours. Entries written before this (no `period`) count as this month.
 */
import {
  APP_TASK_TOOLS_DEFAULT_CAP,
  APP_TASK_TOOLS_ORDER,
  type AppAiProviderChoice,
  type AppTaskTools,
} from "@t3tools/contracts";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeProviderChoice } from "./appAiProviders.ts";

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
  /** Real path the task ran in (older entries may lack it). */
  readonly cwd?: string;
}

function normalizeChatWidget(raw: unknown): StoredApp["chatWidget"] {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return typeof r["seenAt"] === "string"
    ? { guarded: r["guarded"] === true, seenAt: r["seenAt"] }
    : null;
}

/** "2026-09" — the UTC month an app's limit counts. */
export function spendPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export interface StoredApp {
  readonly id: string;
  /** The month `spentUsd` / `taskSpentUsd` belong to ("2026-09", UTC). */
  period: string;
  /** Everything spent in months before `period` (chat + tasks), for display. */
  lifetimeUsd: number;
  tokenHash: string | null;
  tokenIssuedAt: string | null;
  /** Chat and transcription, metered by the daemon call by call. */
  spentUsd: number;
  requests: number;
  tasksStarted: number;
  /**
   * What the app's tasks spent on the Uno AI gateway (the harness calls carry
   * the app label; `appTaskMeter.ts`). Counts against the same limit.
   */
  taskSpentUsd: number;
  /** The gateway's running total for this app last time we looked … */
  taskGatewaySeenUsd: number;
  /** … and for which machine key (a sha256 prefix; a new key starts from 0). */
  taskGatewayKeyTag: string | null;
  lastUsedAt: string | null;
  /** Set by the person in Settings → Apps; null = the manifest's limit. */
  limitOverrideUsd: number | null;
  /** Cloud storage limit set by the person in Settings → Apps; null = the manifest's. */
  storageLimitOverrideGb: number | null;
  /**
   * Which cloud folder the app uses: the one shared by the account's computers
   * (default) or this computer's own (`appStorage.ts`, `appFolder`).
   */
  storageScope: "account" | "computer";
  revoked: boolean;
  taskToolsCap: AppTaskTools;
  /** Where the app's answers go (Settings → Apps); null = Uno AI with the default model. */
  provider: AppAiProviderChoice | null;
  /**
   * The app serves a `<uno-chat>` endpoint (the SDK's chatHandler / chat_sse
   * say so on each call), and whether it checks sign-in (`allow`). Settings
   * and the app's tile warn when an unguarded one is on the internet.
   */
  chatWidget: { guarded: boolean; seenAt: string } | null;
  tasks: StoredAppTask[];
}

interface StoreFile {
  readonly version: 1;
  readonly apps: Record<string, StoredApp>;
  /** Names this computer in cloud folder names when it isn't an Uno computer. */
  readonly localComputerId?: string;
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

function normalizeApp(id: string, raw: unknown, now: Date = new Date()): StoredApp {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const cap = r["taskToolsCap"];
  return {
    id,
    period:
      typeof r["period"] === "string" && /^\d{4}-\d{2}$/.test(r["period"])
        ? r["period"]
        : spendPeriod(now),
    lifetimeUsd: money(r["lifetimeUsd"]),
    tokenHash: typeof r["tokenHash"] === "string" ? r["tokenHash"] : null,
    tokenIssuedAt: typeof r["tokenIssuedAt"] === "string" ? r["tokenIssuedAt"] : null,
    spentUsd: money(r["spentUsd"]),
    requests: money(r["requests"]),
    tasksStarted: money(r["tasksStarted"]),
    taskSpentUsd: money(r["taskSpentUsd"]),
    taskGatewaySeenUsd: money(r["taskGatewaySeenUsd"]),
    taskGatewayKeyTag: typeof r["taskGatewayKeyTag"] === "string" ? r["taskGatewayKeyTag"] : null,
    lastUsedAt: typeof r["lastUsedAt"] === "string" ? r["lastUsedAt"] : null,
    limitOverrideUsd:
      typeof r["limitOverrideUsd"] === "number" && r["limitOverrideUsd"] >= 0
        ? r["limitOverrideUsd"]
        : null,
    storageLimitOverrideGb:
      typeof r["storageLimitOverrideGb"] === "number" && r["storageLimitOverrideGb"] > 0
        ? r["storageLimitOverrideGb"]
        : null,
    storageScope: r["storageScope"] === "computer" ? "computer" : "account",
    revoked: r["revoked"] === true,
    provider: normalizeProviderChoice(r["provider"]),
    chatWidget: normalizeChatWidget(r["chatWidget"]),
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

/**
 * A new month: what the app spent moves into its lifetime total and the
 * limit counts from zero. The gateway's task total (`taskGatewaySeenUsd`)
 * stays, so only its growth from now on counts for the new month.
 * True when it rolled.
 */
export function rollSpendPeriod(app: StoredApp, now: Date): boolean {
  const period = spendPeriod(now);
  if (app.period === period) return false;
  app.lifetimeUsd = Math.round((app.lifetimeUsd + app.spentUsd + app.taskSpentUsd) * 1e6) / 1e6;
  app.spentUsd = 0;
  app.taskSpentUsd = 0;
  app.period = period;
  return true;
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
  /** A random id for this computer, made once and kept (see `appStorageComputerKey`). */
  readonly localComputerId: () => Promise<string>;
}

/** Loads the store (a missing or broken file is an empty store, never a crash). */
export async function openAppAiStore(
  filePath: string,
  options: { readonly now?: () => Date } = {},
): Promise<AppAiStore> {
  const now = options.now ?? (() => new Date());
  const apps = new Map<string, StoredApp>();
  let localComputerId: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<StoreFile>;
    for (const [id, raw] of Object.entries(parsed.apps ?? {})) {
      apps.set(id, normalizeApp(id, raw, now()));
    }
    if (
      typeof parsed.localComputerId === "string" &&
      /^[a-z0-9]{8,32}$/.test(parsed.localComputerId)
    ) {
      localComputerId = parsed.localComputerId;
    }
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
      const body: StoreFile = {
        version: 1,
        apps: Object.fromEntries(apps),
        ...(localComputerId ? { localComputerId } : {}),
      };
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, filePath);
    });
    return writing.catch(() => undefined);
  };

  /** Every read sees the current month; a rollover is written soon after. */
  const fresh = (app: StoredApp | undefined) => {
    if (app && rollSpendPeriod(app, now())) void persist();
    return app;
  };

  const ensure = (id: string) => {
    let app = apps.get(id);
    if (!app) {
      app = normalizeApp(id, {}, now());
      apps.set(id, app);
    }
    return fresh(app)!;
  };

  return {
    get: (id) => fresh(apps.get(id)),
    all: () => [...apps.values()].map((app) => fresh(app)!),
    ensure,
    findByTokenHash: (hash) => {
      for (const app of apps.values()) if (app.tokenHash === hash) return fresh(app);
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
    localComputerId: async () => {
      if (!localComputerId) {
        localComputerId = randomBytes(6).toString("hex");
        await persist();
      }
      return localComputerId;
    },
  };
}
