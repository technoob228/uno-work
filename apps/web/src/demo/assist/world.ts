/**
 * The assistants base (28.10): the state of the made-up account the demo
 * shows. Every switch of the "what to look at" panel and every Playwright
 * flow picks a world here; the fixtures (fixtures.ts), the fake daemons
 * (daemon.ts) and the assistant's scripted replies (engine.ts) read it.
 *
 * Where it comes from, first wins:
 *   1. the page address: `?world=new&tier=free&mac=asleep&tg=on&mode=asks-first
 *      &gmail=expired&drive=off&notion=on&github=on&platform=desktop
 *      &automations=none&gh=norepo`
 *      (any subset; Playwright uses this), saved for the next reload;
 *   2. what the panel saved in this browser (`demo:assist-world`);
 *   3. the defaults below (the "live" account).
 * A change from the panel saves and reloads: the demo starts from the same
 * state every time, so a flow and a screenshot are repeatable.
 */

export type ConnectorProvider = "gmail" | "google-drive" | "notion" | "github";
/** `expired`: listed as connected (the console doesn't know yet), its tools fail with "sign in again". */
export type ConnectorState = "on" | "off" | "expired";

export interface AssistWorld {
  /** `live`: a month of use; `new`: just signed up — one computer, nothing yet. */
  readonly account: "live" | "new";
  /** The account's plan: Free computers fall asleep, Plus keeps uno-work on. */
  readonly tier: "free" | "plus";
  /** The MacBook (live only): online, or asleep (its chats wait). */
  readonly mac: "online" | "asleep";
  /** Telegram linked to Uno (the shared bot), or not yet. */
  readonly telegram: "off" | "on";
  /** The two modes (Misha 23.10): does it itself, or asks first (an Allow card). */
  readonly mode: "itself" | "asks-first";
  /** Work in the browser on uno-work, or the desktop app on the Mac. */
  readonly platform: "cloud" | "desktop";
  readonly connectors: Readonly<Record<ConnectorProvider, ConnectorState>>;
  /** Automations (28.10): a few made already, or none yet. */
  readonly automations: "none" | "some";
  /**
   * The Uno GitHub app for automations: sees the repos (`ok`), doesn't see
   * getuno/web (`norepo`), lacks "Pull requests: write" (`noperm`), not installed (`off`).
   */
  readonly gh: "ok" | "norepo" | "noperm" | "off";
}

export const CONNECTOR_PROVIDERS: ReadonlyArray<ConnectorProvider> = [
  "gmail",
  "google-drive",
  "notion",
  "github",
];

export const LIVE_WORLD: AssistWorld = {
  account: "live",
  tier: "plus",
  mac: "online",
  telegram: "on",
  mode: "itself",
  platform: "cloud",
  connectors: { gmail: "on", "google-drive": "on", notion: "off", github: "on" },
  automations: "some",
  gh: "ok",
};

export const NEW_WORLD: AssistWorld = {
  account: "new",
  tier: "free",
  mac: "online",
  telegram: "off",
  mode: "itself",
  platform: "cloud",
  connectors: { gmail: "off", "google-drive": "off", notion: "off", github: "off" },
  automations: "none",
  gh: "off",
};

const KEY = "demo:assist-world";

/** Short names in the address for the connectors. */
const CONNECTOR_PARAM: Readonly<Record<string, ConnectorProvider>> = {
  gmail: "gmail",
  calendar: "gmail",
  drive: "google-drive",
  "google-drive": "google-drive",
  notion: "notion",
  github: "github",
};

function pick<T extends string>(value: string | null, allowed: ReadonlyArray<T>): T | undefined {
  return value !== null && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : undefined;
}

/** The world the address asks for, over `base` (null: the address asks nothing). */
export function worldFromSearch(search: string, base: AssistWorld): AssistWorld | null {
  const params = new URLSearchParams(search);
  const account = pick(params.get("world"), ["live", "new"] as const);
  const start = account === "new" ? NEW_WORLD : account === "live" ? LIVE_WORLD : base;
  let touched = account !== undefined;
  const take = <T extends string>(name: string, allowed: ReadonlyArray<T>): T | undefined => {
    const value = pick(params.get(name), allowed);
    if (value !== undefined) touched = true;
    return value;
  };
  const connectors = { ...start.connectors };
  for (const [name, provider] of Object.entries(CONNECTOR_PARAM)) {
    const value = take(name, ["on", "off", "expired"] as const);
    if (value) connectors[provider] = value;
  }
  const next: AssistWorld = {
    account: start.account,
    tier: take("tier", ["free", "plus"] as const) ?? start.tier,
    mac: take("mac", ["online", "asleep"] as const) ?? start.mac,
    telegram: take("tg", ["off", "on"] as const) ?? start.telegram,
    mode: take("mode", ["itself", "asks-first"] as const) ?? start.mode,
    platform: take("platform", ["cloud", "desktop"] as const) ?? start.platform,
    connectors,
    automations: take("automations", ["none", "some"] as const) ?? start.automations,
    gh: take("gh", ["ok", "norepo", "noperm", "off"] as const) ?? start.gh,
  };
  return touched ? next : null;
}

function readSaved(): AssistWorld {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AssistWorld> | null;
    if (!saved) return LIVE_WORLD;
    const base = saved.account === "new" ? NEW_WORLD : LIVE_WORLD;
    return { ...base, ...saved, connectors: { ...base.connectors, ...saved.connectors } };
  } catch {
    return LIVE_WORLD;
  }
}

function readWorld(): AssistWorld {
  if (typeof location === "undefined") return LIVE_WORLD;
  const saved = readSaved();
  const asked = worldFromSearch(location.search, saved);
  if (asked) {
    localStorage.setItem(KEY, JSON.stringify(asked));
    return asked;
  }
  return saved;
}

/** Read once at the start: the world doesn't change under a running page. */
export const WORLD: AssistWorld = readWorld();

/** A stamp of the world: the demo's saved chats/tabs are dropped when it changes. */
export function worldStamp(world: AssistWorld): string {
  return JSON.stringify(world);
}

/** The panel's switch: save and start the demo again in that world. */
export function switchWorld(patch: Partial<AssistWorld>) {
  const base =
    patch.account && patch.account !== WORLD.account
      ? patch.account === "new"
        ? NEW_WORLD
        : LIVE_WORLD
      : WORLD;
  const next: AssistWorld = {
    ...base,
    ...patch,
    connectors: { ...base.connectors, ...patch.connectors },
  };
  localStorage.setItem(KEY, JSON.stringify(next));
  // Drop the address' own world, else it would win again after the reload.
  if (location.search) location.replace(`${location.pathname}${location.hash}`);
  else location.reload();
}

export const isLive = (world: AssistWorld = WORLD) => world.account === "live";
export const macOnline = (world: AssistWorld = WORLD) =>
  world.account === "live" && world.mac === "online";
