/**
 * Where a chat an agent starts will run (assistants MVP, 0.0.106).
 *
 * A chat runs where its project lives; for an assistant that is often the
 * person's main computer, not the assistant's own one. The chat-creating
 * paths (`create_thread` of uno-manager, `chat_create` / `POST /api/threads`
 * of uno-work) take the target as `computerId`. Since icp3 (09.10)
 * `chat_create` / `POST /api/threads` start chats on the person's OTHER
 * computers too (`crossComputer/`); uno-manager's `create_thread` still runs
 * them only here.
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

/** Where `computerId` points: this computer, another one (by id or name), or nonsense. */
export type TargetComputer =
  | { readonly kind: "this" }
  | { readonly kind: "other"; readonly ref: string | number }
  | { readonly kind: "invalid" };

/**
 * `computerId` as the agent passed it: absent / `"this"` / this computer's
 * box id (`3120`, `"3120"`, `"box-3120"`) are this computer; any other box id
 * or a computer name is another one. `ownBoxId` is null off a cloud computer
 * (a laptop): then only the "this computer" words mean this one.
 */
export function classifyTargetComputer(raw: unknown, ownBoxId: number | null): TargetComputer {
  if (raw === undefined || raw === null) return { kind: "this" };
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw <= 0) return { kind: "invalid" };
    return ownBoxId !== null && raw === ownBoxId ? { kind: "this" } : { kind: "other", ref: raw };
  }
  if (typeof raw !== "string") return { kind: "invalid" };
  const trimmed = raw.trim();
  const value = trimmed.toLowerCase();
  if (THIS_COMPUTER_WORDS.has(value)) return { kind: "this" };
  if (value.length > 200) return { kind: "invalid" };
  const id = /^(?:box-)?(\d+)$/.exec(value)?.[1];
  if (id !== undefined && ownBoxId !== null && Number(id) === ownBoxId) return { kind: "this" };
  return { kind: "other", ref: trimmed };
}

/**
 * The check for paths that still run chats only here (uno-manager's
 * `create_thread`): another computer is "not allowed yet".
 */
export function checkTargetComputer(raw: unknown, ownBoxId: number | null): TargetComputerCheck {
  return classifyTargetComputer(raw, ownBoxId).kind === "this"
    ? { ok: true }
    : {
        ok: false,
        code: TARGET_COMPUTER_NOT_ALLOWED,
        message: TARGET_COMPUTER_NOT_ALLOWED_MESSAGE,
      };
}

/** This computer's box id from `settings.uno.boxId`, or null. */
export function ownBoxIdFromSettings(
  uno: { readonly boxId?: number | null | undefined } | null | undefined,
): number | null {
  return parseSettingsBoxId(uno?.boxId);
}
