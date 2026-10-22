/**
 * `uno://assistant/<computer>/<assistant>` — an Inbox item about an assistant
 * (one assistant set up another: decision 14.10, a notice, no confirmation).
 * The daemon says `this` for its own computer: the item's.
 */
export function assistantPageOfUrl(
  url: string,
  itemEnvironmentId: string,
): { readonly environmentId: string; readonly projectId: string } | null {
  const match = /^uno:\/\/assistant\/([^/]+)\/(assistant-[^/?#]+)$/.exec(url);
  if (!match) return null;
  const computer = decodeURIComponent(match[1]!);
  return {
    environmentId: computer === "this" ? itemEnvironmentId : computer,
    projectId: decodeURIComponent(match[2]!),
  };
}
