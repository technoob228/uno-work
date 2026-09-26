/**
 * App Store storefront: what to show for a tab, a search and the filters.
 * Pure, so the order ("files and passwords first, developer tools last") is
 * tested without rendering.
 */
import {
  UNO_CONTROL_PLANE_BASE_URL,
  type UnoAppMobile,
  type UnoComputerAppCategory,
  type UnoComputerAppTemplate,
} from "@t3tools/contracts";

import { APP_TASKS } from "./appTaskNames";

export const ALL_TAB = "all";
export const INSTALLED_TAB = "installed";

export interface StoreFilters {
  /** Opens with the Uno account (no separate password). */
  readonly signInWithUno: boolean;
  /** Needs no more memory than this computer has. */
  readonly fitsComputer: boolean;
  /** Has official phone apps that connect to it. */
  readonly phoneApps: boolean;
}

export const NO_FILTERS: StoreFilters = {
  signInWithUno: false,
  fitsComputer: false,
  phoneApps: false,
};

export function hasFilters(filters: StoreFilters): boolean {
  return filters.signInWithUno || filters.fitsComputer || filters.phoneApps;
}

/**
 * Store order: apps made by Uno first, then the console's rank (older consoles
 * send none — their order stays).
 */
const rankKey = (t: UnoComputerAppTemplate) =>
  t.rank && t.rank > 0 ? t.rank : Number.MAX_SAFE_INTEGER;
const unoFirst = (t: UnoComputerAppTemplate) => (t.madeByUno ? 0 : 1);

export function sortByRank(
  templates: ReadonlyArray<UnoComputerAppTemplate>,
): UnoComputerAppTemplate[] {
  return templates
    .map((t, i) => ({ t, i }))
    .toSorted((a, b) => unoFirst(a.t) - unoFirst(b.t) || rankKey(a.t) - rankKey(b.t) || a.i - b.i)
    .map(({ t }) => t);
}

function normalize(text: string): string {
  return text.toLocaleLowerCase().replace(/ё/g, "е").trim();
}

/**
 * Every word of the query is found in the name — the task name ("Passwords")
 * or the product's ("Vaultwarden") — the line, the description or the keywords.
 */
export function matchesQuery(template: UnoComputerAppTemplate, query: string): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const task = APP_TASKS[template.id];
  const haystack = normalize(
    [
      template.name,
      task?.task ?? "",
      task?.product ?? "",
      task?.line ?? "",
      template.tagline ?? "",
      template.description,
      ...(template.keywords ?? []),
    ].join(" \n "),
  );
  return words.every((w) => haystack.includes(w));
}

export function fitsMemory(template: UnoComputerAppTemplate, memTotalMb: number | null): boolean {
  if (memTotalMb === null || template.minRamMb <= 0) return true;
  // The console counts the whole machine (with Uno Work); a 4 GB machine
  // reports a bit less than 4096 — allow for that.
  return template.minRamMb <= memTotalMb * 1.05;
}

export function applyStoreView(input: {
  readonly templates: ReadonlyArray<UnoComputerAppTemplate>;
  readonly tab: string;
  readonly query: string;
  readonly filters: StoreFilters;
  readonly installed: ReadonlySet<string>;
  readonly memTotalMb: number | null;
}): UnoComputerAppTemplate[] {
  return sortByRank(input.templates).filter((t) => {
    if (input.tab === INSTALLED_TAB && !input.installed.has(t.id)) return false;
    if (input.tab !== ALL_TAB && input.tab !== INSTALLED_TAB && t.category !== input.tab) {
      return false;
    }
    if (input.filters.signInWithUno && !t.sso) return false;
    if (input.filters.fitsComputer && !fitsMemory(t, input.memTotalMb)) return false;
    if (input.filters.phoneApps && !t.mobile) return false;
    return matchesQuery(t, input.query);
  });
}

/** "Recommended" on the front page: made by Uno or featured, never a developer tool. */
export function featuredTemplates(
  templates: ReadonlyArray<UnoComputerAppTemplate>,
  categories: ReadonlyArray<UnoComputerAppCategory>,
): UnoComputerAppTemplate[] {
  const technical = new Set(categories.filter((c) => c.technical).map((c) => c.id));
  return sortByRank(templates).filter(
    (t) => (t.featured === true || t.madeByUno === true) && !technical.has(t.category),
  );
}

/**
 * The front page below "Recommended": one shelf per section, in the console's
 * tab order. Apps whose category the console did not declare (older console)
 * land in one "More apps" shelf at the end.
 */
export function shelves(
  templates: ReadonlyArray<UnoComputerAppTemplate>,
  categories: ReadonlyArray<UnoComputerAppCategory>,
): Array<{ id: string; name: string; technical: boolean; apps: UnoComputerAppTemplate[] }> {
  const sorted = sortByRank(templates);
  const known = new Set(categories.map((c) => c.id));
  const out = categories
    .map((c) => ({ ...c, apps: sorted.filter((t) => t.category === c.id) }))
    .filter((s) => s.apps.length > 0);
  const rest = sorted.filter((t) => !known.has(t.category));
  if (rest.length > 0) {
    out.push({
      id: "_more",
      name: categories.length > 0 ? "More apps" : "Apps",
      technical: false,
      apps: rest,
    });
  }
  // Developer shelves go last even if the console lists them earlier.
  return out.toSorted((a, b) => Number(a.technical) - Number(b.technical));
}

export function signInLabel(template: UnoComputerAppTemplate): string | null {
  if (template.sso === "oidc") return "Opens with your Uno account — no extra password";
  if (template.sso === "edge") return "Only people you share it with can open it (Uno account)";
  return null;
}

/** A small icon + word on a store card: what the app is like at a glance. */
export type StoreHighlight =
  | { readonly kind: "uno"; readonly label: "Made by Uno" }
  | { readonly kind: "sso"; readonly label: "Sign in with Uno" }
  | { readonly kind: "ai"; readonly label: "Uses AI" }
  | {
      readonly kind: "phone";
      readonly label: "Phone apps";
      readonly ios: boolean;
      readonly android: boolean;
    }
  | { readonly kind: "memory"; readonly label: string; readonly tight: boolean };

/**
 * The card's highlights, most telling first: made by Uno, signs in with Uno,
 * uses AI, has phone apps, how much memory it wants (a warning when this
 * computer has less).
 */
export function storeHighlights(
  template: UnoComputerAppTemplate,
  fits: boolean | null,
  formatMemory: (mb: number) => string,
): StoreHighlight[] {
  const out: StoreHighlight[] = [];
  if (template.madeByUno) out.push({ kind: "uno", label: "Made by Uno" });
  if (template.sso === "oidc") out.push({ kind: "sso", label: "Sign in with Uno" });
  if (template.ai) out.push({ kind: "ai", label: "Uses AI" });
  if (template.mobile) {
    out.push({
      kind: "phone",
      label: "Phone apps",
      ios: template.mobile.ios !== null,
      android: template.mobile.android !== null,
    });
  }
  if (template.minRamMb > 0) {
    const tight = fits === false;
    const size = formatMemory(template.minRamMb);
    out.push({ kind: "memory", label: tight ? `Needs ${size}` : `${size}+`, tight });
  }
  return out;
}

/** "iOS and Android", "iOS", "Android". */
export function phonePlatforms(mobile: UnoAppMobile): string {
  const names = [mobile.ios ? "iOS" : null, mobile.android ? "Android" : null].filter(Boolean);
  return names.join(" and ");
}

/**
 * Where the logo can come from, in order: the address the computer passes on
 * (its control plane), then the console's own logo by app id — svg, then png.
 * The fallback covers a computer on an older Uno Work that passes no address
 * and an address the browser can't load. Empty — draw the emoji.
 */
export function logoSources(
  template: Pick<UnoComputerAppTemplate, "id" | "iconUrl">,
  base: string = UNO_CONTROL_PLANE_BASE_URL,
): string[] {
  const byId = /^[a-z0-9-]+$/.test(template.id)
    ? [".svg", ".png"].map((ext) => `${base}/api/v1/apps/icons/${template.id}${ext}`)
    : [];
  const given = template.iconUrl ? [template.iconUrl] : [];
  // The given address first; a by-id guess with the other extension goes after it.
  return [...new Set([...given, ...byId])];
}
