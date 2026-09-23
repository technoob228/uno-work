/**
 * App Store storefront: what to show for a tab, a search and the filters.
 * Pure, so the order ("files and passwords first, developer tools last") is
 * tested without rendering.
 */
import type { UnoComputerAppCategory, UnoComputerAppTemplate } from "@t3tools/contracts";

export const ALL_TAB = "all";
export const INSTALLED_TAB = "installed";

export interface StoreFilters {
  /** Opens with the Uno account (no separate password). */
  readonly signInWithUno: boolean;
  /** Needs no more memory than this computer has. */
  readonly fitsComputer: boolean;
}

export const NO_FILTERS: StoreFilters = { signInWithUno: false, fitsComputer: false };

/** Catalog order of the console, by rank when it sends one (older consoles don't). */
export function sortByRank(
  templates: ReadonlyArray<UnoComputerAppTemplate>,
): UnoComputerAppTemplate[] {
  const key = (t: UnoComputerAppTemplate) =>
    t.rank && t.rank > 0 ? t.rank : Number.MAX_SAFE_INTEGER;
  return templates
    .map((t, i) => ({ t, i }))
    .toSorted((a, b) => key(a.t) - key(b.t) || a.i - b.i)
    .map(({ t }) => t);
}

function normalize(text: string): string {
  return text.toLocaleLowerCase().replace(/ё/g, "е").trim();
}

/** Every word of the query is found in the name, the line, the description or the keywords. */
export function matchesQuery(template: UnoComputerAppTemplate, query: string): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalize(
    [
      template.name,
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
    return matchesQuery(t, input.query);
  });
}

/** "Recommended" on the front page: featured, never a developer tool. */
export function featuredTemplates(
  templates: ReadonlyArray<UnoComputerAppTemplate>,
  categories: ReadonlyArray<UnoComputerAppCategory>,
): UnoComputerAppTemplate[] {
  const technical = new Set(categories.filter((c) => c.technical).map((c) => c.id));
  return sortByRank(templates).filter((t) => t.featured === true && !technical.has(t.category));
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
