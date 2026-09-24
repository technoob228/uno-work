/**
 * What the "My Uno" overview decides without React: how a computer reads (Uno
 * Work or a server, on / asleep / not responding), which button its row gets,
 * how the list is filtered, searched, grouped and sorted, what goes into
 * "Worth a look", and how much of the plan is running right now.
 *
 * Only real data: a row says what the console says. There is no "last used"
 * on a box, so nothing here guesses that a computer is idle; there is no site
 * health check, so nothing here calls a site slow.
 */
import type {
  AccountComputer,
  AccountSubscription,
  ComputerApp,
} from "../../account/accountOverview";
import { computerMonthlyShare } from "../../account/billingModel";
import { ROLE_LABEL, type ComputerRole } from "../../account/computerRoles";
import { computerPowerState, type ComputerPowerState } from "../computer/computerFormat";

// ---- apps ----

export type AppHealth = "running" | "installing" | "failed" | "stopped";

/**
 * An App Store app's state from its deployment: the console reports the last
 * deployment (`success`, `failed`, `building`…); older mocks say `running`.
 */
export function appHealth(status: string): AppHealth {
  switch (status) {
    case "success":
    case "running":
    case "ready":
      return "running";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "stopped":
      return "stopped";
    default:
      return "installing";
  }
}

export const APP_HEALTH_LABEL: Record<AppHealth, string> = {
  running: "Running",
  installing: "Installing…",
  failed: "Didn't install",
  stopped: "Stopped",
};

// ---- computers ----

/** One row of the Computers tab: a computer on the account, or this Mac. */
export interface ComputerEntry {
  readonly key: string;
  /** Null for the computer the desktop app runs on (not on the account). */
  readonly box: AccountComputer | null;
  readonly name: string;
  /** Runs Uno Work — "where you work". Otherwise a server. */
  readonly work: boolean;
  readonly local: boolean;
  /** The computer this window works on right now. */
  readonly here: boolean;
  readonly role: ComputerRole;
  readonly state: ComputerPowerState;
  /** The console lost it (`error`): not responding. */
  readonly broken: boolean;
  readonly apps: ReadonlyArray<ComputerApp>;
  /** Host names it answers on: its own address and its apps'. */
  readonly addresses: ReadonlyArray<string>;
}

export function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
}

export function computerEntry(
  box: AccountComputer,
  apps: ReadonlyArray<ComputerApp>,
  here: boolean,
): ComputerEntry {
  const addresses = [box.url, ...apps.map((app) => app.url)]
    .filter((url): url is string => Boolean(url))
    .map(hostOf);
  return {
    key: `box-${box.id}`,
    box,
    name: box.name,
    work: box.workMachine,
    local: false,
    here,
    role: box.role,
    state: computerPowerState(box.status),
    broken: box.status === "error",
    apps,
    addresses: [...new Set(addresses)],
  };
}

export function localEntry(name: string, here: boolean): ComputerEntry {
  return {
    key: "local",
    box: null,
    name,
    work: true,
    local: true,
    here,
    role: "workspace",
    state: "on",
    broken: false,
    apps: [],
    addresses: [],
  };
}

export function isAsleep(entry: ComputerEntry): boolean {
  return entry.state === "asleep" || entry.state === "off";
}

/**
 * The call that brings a computer back: a sleeping one is woken from its
 * snapshot, a stopped one is started. An archived computer comes back only
 * from the console.
 */
export function bringBackAction(status: string): "wake" | "start" | null {
  switch (status) {
    case "sleeping":
    case "paused":
    case "paused_ram":
      return "wake";
    case "stopped":
    case "suspended":
      return "start";
    default:
      return null;
  }
}

/** What a computer's state reads as, in a word. */
export function stateLabel(entry: ComputerEntry): string {
  if (entry.broken) return "Not responding";
  if (entry.box?.status === "archived") return "Archived";
  switch (entry.state) {
    case "on":
      return "On";
    case "asleep":
      return "Asleep";
    case "off":
      return "Off";
    case "busy":
      return entry.box?.status === "stopping" || entry.box?.status === "sleeping_pending"
        ? "Going to sleep…"
        : "Starting…";
    default:
      return "Unknown";
  }
}

export type StateTone = "ok" | "idle" | "busy" | "bad" | "off";

export function stateTone(entry: ComputerEntry): StateTone {
  if (entry.broken) return "bad";
  switch (entry.state) {
    case "on":
      return "ok";
    case "asleep":
      return "idle";
    case "busy":
      return "busy";
    default:
      return "off";
  }
}

/** The one button a row carries — the rest lives in the side panel. */
export type RowAction = "here" | "open" | "wake" | "none";

export function rowAction(entry: ComputerEntry): RowAction {
  if (entry.box && isAsleep(entry)) {
    return bringBackAction(entry.box.status) ? "wake" : "none";
  }
  // A server is checked, not opened: no button while it runs.
  if (!entry.work || entry.broken || entry.state === "busy") return "none";
  if (entry.here) return "here";
  return entry.state === "on" ? "open" : "none";
}

export type ComputerFilter = "all" | "work" | "servers" | "asleep";

export function matchesFilter(entry: ComputerEntry, filter: ComputerFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "work":
      return entry.work;
    case "servers":
      return !entry.work;
    case "asleep":
      return isAsleep(entry);
  }
}

/** Search by name, note, role, app and address — "where is my n8n?". */
export function matchesQuery(entry: ComputerEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    entry.name,
    entry.box?.note ?? "",
    entry.work ? "uno work" : ROLE_LABEL[entry.role],
    entry.local ? "this mac this computer" : "",
    ...entry.apps.map((app) => app.name),
    ...entry.addresses,
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

/** Servers in the order others depend on them. */
const SERVER_ORDER: Record<ComputerRole, number> = {
  production: 0,
  server: 1,
  staging: 2,
  sandbox: 3,
  workspace: 4,
};

/**
 * Uno Work computers: the one you're on, this Mac, awake before asleep, then
 * by name. Servers: broken first (that's what you came for), then by role,
 * awake before asleep, then by name.
 */
export function sortEntries(entries: ReadonlyArray<ComputerEntry>): ComputerEntry[] {
  return entries.toSorted((a, b) => {
    if (a.work !== b.work) return a.work ? -1 : 1;
    const byName = a.name.localeCompare(b.name);
    const asleep = Number(isAsleep(a)) - Number(isAsleep(b));
    if (a.work) {
      return (
        Number(b.here) - Number(a.here) || Number(b.local) - Number(a.local) || asleep || byName
      );
    }
    return (
      Number(b.broken) - Number(a.broken) ||
      SERVER_ORDER[a.role] - SERVER_ORDER[b.role] ||
      asleep ||
      byName
    );
  });
}

export interface ComputerGroups {
  readonly work: ReadonlyArray<ComputerEntry>;
  readonly servers: ReadonlyArray<ComputerEntry>;
}

export function groupEntries(
  entries: ReadonlyArray<ComputerEntry>,
  filter: ComputerFilter,
  query: string,
): ComputerGroups {
  const shown = sortEntries(entries).filter(
    (entry) => matchesFilter(entry, filter) && matchesQuery(entry, query),
  );
  return {
    work: shown.filter((entry) => entry.work),
    servers: shown.filter((entry) => !entry.work),
  };
}

export function filterCounts(
  entries: ReadonlyArray<ComputerEntry>,
): Record<ComputerFilter, number> {
  return {
    all: entries.length,
    work: entries.filter((entry) => entry.work).length,
    servers: entries.filter((entry) => !entry.work).length,
    asleep: entries.filter(isAsleep).length,
  };
}

// ---- worth a look ----

export type WorthItem =
  | { readonly key: string; readonly kind: "computer"; readonly entry: ComputerEntry }
  | {
      readonly key: string;
      readonly kind: "app";
      readonly entry: ComputerEntry;
      readonly app: ComputerApp;
    };

/**
 * Only what needs a decision: a computer that stopped answering, an app that
 * didn't install. Nothing when all is well — the page then says so in a line.
 */
export function worthALook(entries: ReadonlyArray<ComputerEntry>): ReadonlyArray<WorthItem> {
  const items: WorthItem[] = [];
  for (const entry of sortEntries(entries)) {
    if (entry.local) continue;
    if (entry.broken) items.push({ key: `computer-${entry.key}`, kind: "computer", entry });
    for (const app of entry.apps) {
      if (appHealth(app.status) === "failed") {
        items.push({ key: `app-${entry.key}-${app.id}`, kind: "app", entry, app });
      }
    }
  }
  return items;
}

export function hasProblem(entry: ComputerEntry): boolean {
  return entry.broken || entry.apps.some((app) => appHealth(app.status) === "failed");
}

// ---- money ----

/** "≈ $8.38/mo of the plan" for one computer; null when the plan doesn't say. */
export function entryShare(
  entry: ComputerEntry,
  subscription: AccountSubscription | null,
): number | null {
  if (!entry.box) return null;
  return computerMonthlyShare(entry.box, subscription);
}

/** What a group costs out of the plan; null when no computer in it has a price. */
export function groupShare(
  entries: ReadonlyArray<ComputerEntry>,
  subscription: AccountSubscription | null,
): number | null {
  let total = 0;
  let priced = false;
  for (const entry of entries) {
    const share = entryShare(entry, subscription);
    if (share === null) continue;
    total += share;
    priced = true;
  }
  return priced ? Math.round(total * 100) / 100 : null;
}

export interface PlanRunning {
  readonly usedRamMb: number;
  readonly peakRamMb: number;
  readonly freeRamMb: number;
  readonly pct: number;
}

/**
 * How much of the plan's "everything running at once" is running now — the
 * plan's real limit (sleeping computers don't count). Null without a plan.
 */
export function planRunning(subscription: AccountSubscription | null): PlanRunning | null {
  const peak = subscription?.limits?.peakRamMb ?? 0;
  if (!subscription || peak <= 0) return null;
  const used = Math.max(0, subscription.usage.runningRamMb);
  return {
    usedRamMb: used,
    peakRamMb: peak,
    freeRamMb: Math.max(0, peak - used),
    pct: Math.min(100, Math.round((used / peak) * 100)),
  };
}

// ---- sites ----

export function matchesSite(
  site: { readonly slug: string; readonly url: string; readonly customDomain: string | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${site.slug} ${site.url} ${site.customDomain ?? ""}`.toLowerCase().includes(q);
}
