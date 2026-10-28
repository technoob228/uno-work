/**
 * Whether a chat may be started on another computer, and in what mode — the
 * rules shared by `chat_create` (agent bridge) and `create_thread`
 * (uno-manager) (assistants D, 28.10).
 *
 * - An assistant limited to selected projects stays on this computer: those
 *   projects are a boundary here (bubblewrap, the project allowlist), and the
 *   other computer knows nothing of them. A real boundary, not a promise in
 *   the prompt (Misha 23.10), so the start is refused with plain words.
 * - The chat there runs in at most the asking chat's own mode (narrowed to
 *   the assistant's preset): "Cautious" stays "asks first" on the other
 *   computer too.
 * - A project of THIS computer named by id is sent as its folder (projects
 *   synced between computers keep the same folder under the home).
 *
 * @module remoteComputers/remoteChatPolicy
 */
import type { ManagerProjectAllowlist } from "@t3tools/contracts";

export type RemoteChatPermission =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "remote_not_allowed"; readonly message: string };

export function remoteChatPermission(input: {
  /** The asking assistant's project allowlist; null: the person's own chat. */
  readonly allowlist: ManagerProjectAllowlist | null;
  readonly assistantName: string | null;
  readonly computerName: string;
}): RemoteChatPermission {
  if (input.allowlist === null || input.allowlist === "all") return { ok: true };
  const who = input.assistantName ?? "This assistant";
  return {
    ok: false,
    code: "remote_not_allowed",
    message: `${who} works only in its selected projects on this computer, so it can't start chats on ${input.computerName} (that boundary doesn't reach another computer). Start the chat here, or tell the person: they can give ${who} every project on its page in Uno Work.`,
  };
}

/** `/home/uno/projects/site` → `~/projects/site` (the other computer's home differs). */
export function portableFolder(workspaceRoot: string, home: string): string {
  const trimmedHome = home.replace(/\/+$/, "");
  if (trimmedHome.length > 0 && workspaceRoot === trimmedHome) return "~";
  if (trimmedHome.length > 0 && workspaceRoot.startsWith(`${trimmedHome}/`)) {
    return `~${workspaceRoot.slice(trimmedHome.length)}`;
  }
  return workspaceRoot;
}

/** What the tool answers after a chat started on another computer. */
export function remoteChatStartedNote(computerName: string, fromAssistant: boolean): string {
  const carries = `There it uses ${computerName}'s connected apps within your app levels; your own MCP servers and keys don't go along.`;
  return fromAssistant
    ? `Started on ${computerName}. ${carries} Its result comes to you by itself (a work update) — end your turn now with one short line; work_status lists it meanwhile.`
    : `Started on ${computerName}. The person sees it in Uno Work on that computer.`;
}
