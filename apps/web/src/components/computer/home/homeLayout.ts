/**
 * Home as one arrangeable layout (0.0.82): the greeting, the composer, Continue,
 * the built-in widgets (Files, Apps…) and apps' own widgets are all blocks of
 * the same list. Customize drags them and × hides them — except the composer,
 * which can move but never goes away (Home without it has no way to start).
 *
 * Kept per device in localStorage. The 0.0.81 layout (only the widgets under
 * Continue) is migrated once: greeting, composer, Continue, then those widgets
 * in the person's order.
 */
import {
  DEFAULT_HOME_WIDGETS,
  isHomeWidgetId,
  normalizeHomeWidgets,
  type HomeWidgetId,
} from "./homeModel";

export const HOME_LAYOUT_KEY = "uno-work:home:layout:v2";
/** The 0.0.81 key (widgets under Continue only). Read once for the migration. */
export const HOME_WIDGETS_V1_KEY = "uno-work:home:widgets";

export const HOME_FIXED_BLOCKS = ["greeting", "composer", "continue"] as const;
export type HomeFixedBlockId = (typeof HOME_FIXED_BLOCKS)[number];

/** `app:<manifest id>` — a widget an app declares in its manifest. */
export type AppWidgetBlockId = `app:${string}`;
export type HomeBlockId = HomeFixedBlockId | HomeWidgetId | AppWidgetBlockId;

export const COMPOSER_BLOCK: HomeFixedBlockId = "composer";

export const DEFAULT_HOME_LAYOUT: ReadonlyArray<HomeBlockId> = [
  ...HOME_FIXED_BLOCKS,
  ...DEFAULT_HOME_WIDGETS,
];

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
 * default.
 */
export function migrateHomeLayout(v2: unknown, v1: unknown): HomeBlockId[] {
  if (Array.isArray(v2)) return normalizeHomeLayout(v2);
  if (Array.isArray(v1))
    return normalizeHomeLayout([...HOME_FIXED_BLOCKS, ...normalizeHomeWidgets(v1)]);
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

/** Blocks that can still be added: available here and not on Home yet. */
export function addableBlocks(
  state: ReadonlyArray<HomeBlockId>,
  available: ReadonlyArray<HomeBlockId>,
): HomeBlockId[] {
  return available.filter((id) => !state.includes(id));
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
