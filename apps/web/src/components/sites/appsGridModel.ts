/**
 * The search of the Apps tab (Apps & sites): like Launchpad on a Mac — type
 * and only the apps whose name has those letters stay. A word matches the
 * start of any word of the name, the product name or the caption ("note"
 * finds "Notetaker", "files" finds "Files & documents · Nextcloud"), any case.
 */
export interface AppsGridEntry {
  readonly name: string;
  readonly product?: string | null | undefined;
  readonly caption?: string | null | undefined;
}

function words(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function matchesAppSearch(entry: AppsGridEntry, query: string): boolean {
  const wanted = words(query);
  if (wanted.length === 0) return true;
  const haystack = words([entry.name, entry.product ?? "", entry.caption ?? ""].join(" "));
  return wanted.every((part) => haystack.some((word) => word.startsWith(part)));
}

export function filterAppsBySearch<T extends AppsGridEntry>(
  entries: ReadonlyArray<T>,
  query: string,
): T[] {
  return entries.filter((entry) => matchesAppSearch(entry, query));
}
