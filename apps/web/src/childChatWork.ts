// The chats a chat's agent started, folded onto the parent's sidebar summary:
// "Ready" needs to know when the person's request waited for them and the
// last one is done (Sidebar.owner, Misha 13.11 — the safety net for an agent
// that forgot to call the person when it finished).
import type { ThreadId } from "@t3tools/contracts";

import type { ChildChatWork, SidebarThreadSummary } from "./types";

function isChildGoing(child: SidebarThreadSummary): boolean {
  if (child.archivedAt !== null) return false;
  if (child.hasPendingApprovals || child.hasPendingUserInput) return true;
  const session = child.session;
  return (
    session?.status === "running" ||
    session?.status === "connecting" ||
    session?.orchestrationStatus === "running" ||
    session?.orchestrationStatus === "starting"
  );
}

const sameWork = (left: ChildChatWork | undefined, right: ChildChatWork | undefined) =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.working === right.working &&
    left.latestStartedAt === right.latestStartedAt);

/**
 * The summaries with each parent's `childWork` up to date. Returns the same
 * record (and the same summary objects) when nothing changed, so the store
 * does not re-render the sidebar for it.
 */
export function withChildChatWork(
  byId: Record<ThreadId, SidebarThreadSummary>,
): Record<ThreadId, SidebarThreadSummary> {
  const work = new Map<string, { working: number; latestStartedAt: string }>();
  for (const child of Object.values(byId)) {
    const parentId = child.spawnedByThreadId;
    if (parentId == null) continue;
    const entry = work.get(parentId);
    const going = isChildGoing(child) ? 1 : 0;
    if (entry === undefined) {
      work.set(parentId, { working: going, latestStartedAt: child.createdAt });
    } else {
      entry.working += going;
      if (child.createdAt > entry.latestStartedAt) entry.latestStartedAt = child.createdAt;
    }
  }
  let out = byId;
  for (const [id, summary] of Object.entries(byId) as Array<[ThreadId, SidebarThreadSummary]>) {
    const next = work.get(id);
    if (sameWork(summary.childWork, next)) continue;
    if (out === byId) out = { ...byId };
    if (next === undefined) {
      const { childWork: _gone, ...rest } = summary;
      out[id] = rest;
    } else {
      out[id] = { ...summary, childWork: next };
    }
  }
  return out;
}
