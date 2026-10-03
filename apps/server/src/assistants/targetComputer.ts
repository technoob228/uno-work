/**
 * Where a chat an agent starts will run (assistants MVP, 0.0.106).
 *
 * A chat runs where its project lives; for an assistant that is often the
 * person's main computer, not the assistant's own one. Starting chats on
 * another computer needs the person's Allow for the pair "assistant →
 * computer", checked by the server (spec of cross-machine sending, next
 * wave). Until then the chat-creating paths (`create_thread` of uno-manager,
 * `chat_create` / `POST /api/threads` of uno-work) already take the target
 * as `computerId` — so nothing is hard-wired to "local" — and accept only
 * this computer.
 *
 * @module assistants/targetComputer
 */
import { parseSettingsBoxId } from "../unoBoxIdentity.ts";

export const TARGET_COMPUTER_NOT_ALLOWED = "computer_not_allowed";

export const TARGET_COMPUTER_NOT_ALLOWED_MESSAGE =
  "Starting chats on another computer is not allowed yet. Leave computerId out to start the chat on this computer.";

const THIS_COMPUTER_WORDS = new Set(["", "this", "self", "local", "here"]);

export type TargetComputerCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * `computerId` as the agent passed it: absent / `"this"` / this computer's
 * box id (`3120`, `"3120"`, `"box-3120"`) are fine; anything else is not
 * allowed yet. `ownBoxId` is null off a cloud computer (a laptop): then only
 * the "this computer" forms pass.
 */
export function checkTargetComputer(raw: unknown, ownBoxId: number | null): TargetComputerCheck {
  if (raw === undefined || raw === null) return { ok: true };
  const notAllowed = {
    ok: false,
    code: TARGET_COMPUTER_NOT_ALLOWED,
    message: TARGET_COMPUTER_NOT_ALLOWED_MESSAGE,
  } as const;
  if (typeof raw === "number") {
    return ownBoxId !== null && raw === ownBoxId ? { ok: true } : notAllowed;
  }
  if (typeof raw !== "string") return notAllowed;
  const value = raw.trim().toLowerCase();
  if (THIS_COMPUTER_WORDS.has(value)) return { ok: true };
  const id = /^(?:box-)?(\d+)$/.exec(value)?.[1];
  if (id !== undefined && ownBoxId !== null && Number(id) === ownBoxId) return { ok: true };
  return notAllowed;
}

/** This computer's box id from `settings.uno.boxId`, or null. */
export function ownBoxIdFromSettings(
  uno: { readonly boxId?: number | null | undefined } | null | undefined,
): number | null {
  return parseSettingsBoxId(uno?.boxId);
}
