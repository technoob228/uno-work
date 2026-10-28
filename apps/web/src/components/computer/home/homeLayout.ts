/**
 * Home as one arrangeable layout (0.0.82): the greeting, the composer, Continue,
 * the built-in widgets (Files, Apps…) and apps' own widgets are all blocks of
 * the same list. Customize drags them and × hides them — except the composer,
 * which can move but never goes away (Home without it has no way to start).
 *
 * Kept per device in localStorage. The 0.0.81 layout (only the widgets under
 * Continue) is migrated once: greeting, composer, Continue, then those widgets
 * in the person's order.
 *
 * Since 01.10 (simplification) Home starts with no widgets: the start screen
 * is the field "What should we do?", what needs you and what's in progress.
 * A layout nobody touched (the old default with Files and Apps) moves to the
 * new default; a layout the person arranged is kept.
 *
 * Since 0.0.157 one widget comes with Home: "AI plan limits" (shown only
 * where Claude Code or Codex is signed in). It is put on existing layouts
 * too, once per device — see newBuiltInWidgetBlocks.
 */
import {
  DEFAULT_HOME_WIDGETS,
  isHomeWidgetId,
  normalizeHomeWidgets,
  type HomeWidgetId,
} from "./homeModel";

export const HOME_LAYOUT_KEY = "uno-work:home:layout:v3";
/** The 0.0.82–0.0.103 key. Read once for the migration. */
export const HOME_LAYOUT_V2_KEY = "uno-work:home:layout:v2";
/** The 0.0.81 key (widgets under Continue only). Read once for the migration. */
export const HOME_WIDGETS_V1_KEY = "uno-work:home:widgets";

export const HOME_FIXED_BLOCKS = ["greeting", "composer", "continue"] as const;
export type HomeFixedBlockId = (typeof HOME_FIXED_BLOCKS)[number];

/** `app:<manifest id>` — a widget an app declares in its manifest. */
export type AppWidgetBlockId = `app:${string}`;
export type HomeBlockId = HomeFixedBlockId | HomeWidgetId | AppWidgetBlockId;

export const COMPOSER_BLOCK: HomeFixedBlockId = "composer";

/**
 * Built-in widgets every Home starts with (0.0.157: "AI plan limits", which
 * hides itself without a Claude Code / Codex sign-in). The rest (01.10) come
 * from Customize → Add widget.
 */
export const SEEDED_HOME_WIDGETS: ReadonlyArray<HomeWidgetId> = ["plan-limits"];

export const DEFAULT_HOME_LAYOUT: ReadonlyArray<HomeBlockId> = [
  ...HOME_FIXED_BLOCKS,
  ...SEEDED_HOME_WIDGETS,
];

/** The default until 0.0.103: the fixed blocks, then Files and Apps. */
const UNTOUCHED_V2_LAYOUT: ReadonlyArray<HomeBlockId> = [
  ...HOME_FIXED_BLOCKS,
  ...DEFAULT_HOME_WIDGETS,
];

function sameBlocks(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

const APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function appWidgetBlockId(manifestId: string): AppWidgetBlockId {
  return `app:${manifestId}`;
}

export function isAppWidgetBlockId(value: unknown): value is AppWidgetBlockId {
  return typeof value === "string" && value.startsWith("app:") && APP_ID_RE.test(value.slice(4));
}

export function appIdOfBlock(id: AppWidgetBlockId): string {
  return id.slice(4);
}

export function isHomeFixedBlockId(value: unknown): value is HomeFixedBlockId {
  return typeof value === "string" && (HOME_FIXED_BLOCKS as ReadonlyArray<string>).includes(value);
}

export function isHomeBlockId(value: unknown): value is HomeBlockId {
  return isHomeFixedBlockId(value) || isHomeWidgetId(value) || isAppWidgetBlockId(value);
}

/**
 * A stored layout, cleaned: known ids once each, and the composer always
 * there (put back at the top — after the greeting when that leads — if a bad
 * value lost it). Anything unreadable gives the default.
 */
export function normalizeHomeLayout(raw: unknown): HomeBlockId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_HOME_LAYOUT];
  const seen = new Set<HomeBlockId>();
  for (const item of raw) {
    if (isHomeBlockId(item)) seen.add(item);
  }
  const out = [...seen];
  if (!seen.has(COMPOSER_BLOCK)) out.splice(out[0] === "greeting" ? 1 : 0, 0, COMPOSER_BLOCK);
  return out;
}

/**
 * The layout to start from: the saved 0.0.82 layout when there is one, else
 * the 0.0.81 widget list behind greeting, composer and Continue, else the
 * default. A saved layout that is just the old default (nobody arranged it)
 * becomes the new default — no widgets.
 */
export function migrateHomeLayout(v2: unknown, v1: unknown): HomeBlockId[] {
  if (Array.isArray(v2)) {
    const layout = normalizeHomeLayout(v2);
    return sameBlocks(layout, UNTOUCHED_V2_LAYOUT) ? [...DEFAULT_HOME_LAYOUT] : layout;
  }
  if (Array.isArray(v1)) {
    const widgets = normalizeHomeWidgets(v1);
    return sameBlocks(widgets, DEFAULT_HOME_WIDGETS)
      ? [...DEFAULT_HOME_LAYOUT]
      : normalizeHomeLayout([...HOME_FIXED_BLOCKS, ...widgets]);
  }
  return [...DEFAULT_HOME_LAYOUT];
}

export type HomeLayoutAction =
  | { readonly type: "add"; readonly id: HomeBlockId }
  | { readonly type: "remove"; readonly id: HomeBlockId }
  | { readonly type: "move"; readonly from: HomeBlockId; readonly to: HomeBlockId }
  | { readonly type: "reset" };

export function homeLayoutReducer(
  state: ReadonlyArray<HomeBlockId>,
  action: HomeLayoutAction,
): HomeBlockId[] {
  switch (action.type) {
    case "add":
      return state.includes(action.id) ? [...state] : [...state, action.id];
    case "remove":
      if (action.id === COMPOSER_BLOCK) return [...state];
      return state.filter((id) => id !== action.id);
    case "move": {
      const from = state.indexOf(action.from);
      const to = state.indexOf(action.to);
      if (from === -1 || to === -1 || from === to) return [...state];
      const next = [...state];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    }
    case "reset":
      return [...DEFAULT_HOME_LAYOUT];
  }
}

/**
 * "In progress" on the simple Home is the `continue` block (the same
 * chats-in-progress list as Continue on the full one). Shown by default; the
 * person can hide it with one click (Misha 08.10: he doesn't want it) and
 * Customize → Add widget (or Reset) brings it back. Kept in the layout, so
 * the choice is remembered on this device like any other widget.
 */
export const IN_PROGRESS_BLOCK: HomeFixedBlockId = "continue";

export function inProgressShown(state: ReadonlyArray<HomeBlockId>): boolean {
  return state.includes(IN_PROGRESS_BLOCK);
}

export function hideInProgress(): HomeLayoutAction {
  return { type: "remove", id: IN_PROGRESS_BLOCK };
}

export function showInProgress(): HomeLayoutAction {
  return { type: "add", id: IN_PROGRESS_BLOCK };
}

/** Blocks that can still be added: available here and not on Home yet. */
export function addableBlocks(
  state: ReadonlyArray<HomeBlockId>,
  available: ReadonlyArray<HomeBlockId>,
): HomeBlockId[] {
  return available.filter((id) => !state.includes(id));
}

// ------------------------------------------ built-in widgets land on Home --

/** Built-in widgets this device has already put on Home (or found there). */
export const HOME_BUILT_IN_WIDGETS_SEEN_KEY = "uno-work:home:built-in-widgets-seen:v1";

/**
 * A built-in widget that comes with Home (SEEDED_HOME_WIDGETS) is put on a
 * layout saved before it existed — once per device. Removing it with × is
 * the person's choice and sticks: it isn't brought back. Unlike apps'
 * widgets, an updated device gets it too (it's new to everyone).
 *
 * `seen` null — this device never recorded it.
 */
export function newBuiltInWidgetBlocks(input: {
  readonly blocks: ReadonlyArray<HomeBlockId>;
  readonly seen: ReadonlyArray<string> | null;
  readonly seeded?: ReadonlyArray<HomeWidgetId>;
}): { readonly add: HomeWidgetId[]; readonly seen: string[] } {
  const known = new Set(input.seen ?? []);
  const fresh = (input.seeded ?? SEEDED_HOME_WIDGETS).filter((id) => !known.has(id));
  return {
    add: fresh.filter((id) => !input.blocks.includes(id)),
    seen: [...known, ...fresh],
  };
}

// ------------------------------------------------------------ app widgets --

export type AppWidgetSize = "small" | "medium" | "wide";

/** Columns out of 4 a block takes on a wide screen. */
export function appWidgetSpan(size: AppWidgetSize): 1 | 2 | 4 {
  return size === "small" ? 1 : size === "wide" ? 4 : 2;
}

/**
 * The frame's address: the app's own address with the widget's path. Null for
 * anything that isn't http(s) (the manifest path is validated by the daemon;
 * this is the second fence).
 */
export function appWidgetUrl(base: string, path: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  const [pathname = "", search = ""] = path.split("?", 2);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
  url.search = search ? `?${search}` : "";
  url.hash = "";
  return url.toString();
}

/**
 * The widget frame's sandbox. The app keeps its own origin (its cookies, its
 * fetches to itself) only when that origin differs from Uno Work's — then the
 * browser already keeps it away from Work's cookies and DOM. An app served
 * from Work's own origin gets an opaque origin instead. Never top navigation,
 * never same-origin with Work.
 */
export function appWidgetSandbox(widgetUrl: string, workOrigin: string): string {
  let origin: string;
  try {
    origin = new URL(widgetUrl).origin;
  } catch {
    return "allow-scripts";
  }
  return origin === workOrigin
    ? "allow-scripts"
    : "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";
}

/** Three ideas for "Add custom widget", from the person's own apps when there are some. */
export function customWidgetIdeas(appNames: ReadonlyArray<string>): string[] {
  const names = [...new Set(appNames.map((name) => name.trim()).filter(Boolean))];
  const ideas = names
    .slice(0, 2)
    .map((name) => `Make a Home widget that shows what's new in ${name} today`);
  const generic = [
    "Make a Home widget that shows today's orders from my shop site",
    "Make a Home widget with my to-do list that I can tick off",
    "Make a Home widget that shows how much disk and memory this computer uses",
  ];
  for (const idea of generic) {
    if (ideas.length >= 3) break;
    ideas.push(idea);
  }
  return ideas;
}

// ------------------------------------------- app widgets land on Home --

/** App widgets this device has already put on Home (or found there), by manifest id. */
export const HOME_APP_WIDGETS_SEEN_KEY = "uno-work:home:app-widgets-seen:v1";

/**
 * A widget an app declares lands on Home by itself, once per device (P16,
 * 28.10: the agent made "Plan limits", told the person "Home → Customize →
 * Add widget", and the person had to do it by hand). Removing it with × is
 * the person's choice and sticks: the widget isn't brought back.
 *
 * `seen` null — this device never recorded it. On a device with a Home
 * layout already (an update) the widgets that exist now are taken as seen,
 * not added: one the person removed before stays removed. A device with no
 * layout yet (a new browser) shows them all.
 */
export function newAppWidgetBlocks(input: {
  readonly widgetAppIds: ReadonlyArray<string>;
  readonly seen: ReadonlyArray<string> | null;
  readonly layoutSaved: boolean;
}): { readonly add: AppWidgetBlockId[]; readonly seen: string[] } {
  const ids = [...new Set(input.widgetAppIds.filter((id) => APP_ID_RE.test(id)))];
  if (input.seen === null) {
    return {
      add: input.layoutSaved ? [] : ids.map(appWidgetBlockId),
      seen: ids,
    };
  }
  const known = new Set(input.seen);
  const fresh = ids.filter((id) => !known.has(id));
  return {
    add: fresh.map(appWidgetBlockId),
    seen: fresh.length === 0 ? [...input.seen] : [...input.seen, ...fresh],
  };
}
