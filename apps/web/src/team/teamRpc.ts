/**
 * T51's three daemon calls, from the web: `team.state` (what this Work
 * mirrors, errors), `team.refresh` (mirror again now — after Share),
 * `team.letAgentAnswer({ requestId })` ("Let my agent answer" a colleague's
 * question, read-only).
 *
 * The daemon side (apps/server, contracts) lands separately. Until then the
 * environment API has no `team` group and every call here answers "not
 * there" instead of throwing: the UI hides what needs it. MERGE: once
 * `EnvironmentApi.team` exists (environmentApi.ts → `team: { state,
 * refresh, letAgentAnswer }` over `rpcClient.team.*`), nothing here needs to
 * change — `teamRpcOf` finds it.
 *
 * @module team/teamRpc
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { readEnvironmentApi } from "../environmentApi";

export interface TeamRpc {
  readonly state: () => Promise<unknown>;
  readonly refresh: () => Promise<unknown>;
  readonly letAgentAnswer: (input: { readonly requestId: number }) => Promise<unknown>;
}

/** The demo answers these in the page (demo/teamCollabDemo.ts). */
let override: ((environmentId: EnvironmentId) => TeamRpc | null) | null = null;

export function setTeamRpcOverride(next: typeof override): void {
  override = next;
}

function teamRpcOf(environmentId: EnvironmentId | null): TeamRpc | null {
  if (!environmentId) return null;
  if (override) return override(environmentId);
  const api = readEnvironmentApi(environmentId) as unknown as { team?: Partial<TeamRpc> } | null;
  const team = api?.team;
  if (
    !team ||
    typeof team.state !== "function" ||
    typeof team.refresh !== "function" ||
    typeof team.letAgentAnswer !== "function"
  ) {
    return null;
  }
  return team as TeamRpc;
}

/** This Work can do T51's daemon part (a version with `team.*`). */
export const teamRpcAvailable = (environmentId: EnvironmentId | null) =>
  teamRpcOf(environmentId) !== null;

/** What the daemon mirrors and what failed; null — no such daemon or it didn't answer. */
export async function teamDaemonState(environmentId: EnvironmentId | null): Promise<unknown> {
  const team = teamRpcOf(environmentId);
  if (!team) return null;
  try {
    return await team.state();
  } catch {
    return null;
  }
}

/** Mirror now (after a share changed). False when it couldn't: it mirrors within 30 s anyway. */
export async function teamDaemonRefresh(environmentId: EnvironmentId | null): Promise<boolean> {
  const team = teamRpcOf(environmentId);
  if (!team) return false;
  try {
    await team.refresh();
    return true;
  } catch {
    return false;
  }
}

/** "Let my agent answer": a read-only session answers the question. Null on success, else why. */
export async function teamLetAgentAnswer(
  environmentId: EnvironmentId | null,
  requestId: number,
): Promise<string | null> {
  const team = teamRpcOf(environmentId);
  if (!team) return "Uno Work on this computer can't do that yet. Answer it yourself.";
  try {
    await team.letAgentAnswer({ requestId });
    return null;
  } catch (cause) {
    const message = (cause as { message?: unknown } | null)?.message;
    return typeof message === "string" && message.trim()
      ? message.trim()
      : "Your agent couldn't take it. Try again or answer it yourself.";
  }
}

/** A mirror error the daemon reports for this chat, if its state says one (shape kept loose). */
export function mirrorErrorFor(state: unknown, threadId: string): string | null {
  const chats = (state as { chats?: unknown } | null)?.chats;
  if (!Array.isArray(chats)) return null;
  for (const chat of chats) {
    const item = chat as { threadId?: unknown; error?: unknown };
    if (item.threadId === threadId && typeof item.error === "string" && item.error.trim()) {
      return item.error.trim();
    }
  }
  return null;
}
