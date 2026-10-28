/**
 * The assistants block at the top of the sidebar (Misha 23.10): with the
 * team on the account, a small "Assistants" header with "+" — always there,
 * however many assistants there are (it used to vanish with the second one).
 * Without the team it is Uno alone: no header, no "+".
 *
 * Misha 28.10 (variant D): the gear next to "+" opens the assistants'
 * settings; the whole block can be hidden — one small "Show assistants" line
 * stays; an assistant's group of chats folds even while one of them is open.
 *
 * Pure.
 */
export interface AssistantsHeaderState {
  /** The "Assistants" label row. */
  readonly showHeader: boolean;
  /** "+" next to it: opens the gallery of assistants. */
  readonly showCreate: boolean;
  /** The gear next to "+": the assistants' settings. */
  readonly showSettings: boolean;
  /** The assistants themselves (hidden by the person: none). */
  readonly showList: boolean;
  /** The one small line that brings the block back. */
  readonly showRestore: boolean;
}

export function assistantsHeaderState(input: {
  readonly teamShown: boolean;
  /** The person hid the block (this device). Only the team's block hides. */
  readonly hidden?: boolean;
}): AssistantsHeaderState {
  const hidden = input.teamShown && input.hidden === true;
  return {
    showHeader: input.teamShown && !hidden,
    showCreate: input.teamShown && !hidden,
    showSettings: input.teamShown && !hidden,
    showList: !hidden,
    showRestore: hidden,
  };
}

/** What the person chose for an assistant's group of chats; undefined — never touched. */
export type AssistantFoldChoice = "open" | "closed" | undefined;

/**
 * Whether an assistant's chats show under its row. Untouched, it opens only
 * while one of its chats is open (as before 28.10); the person's own choice
 * wins — the bug was that a group holding the open chat could not be folded.
 */
export function assistantChatsUnfolded(input: {
  readonly choice: AssistantFoldChoice;
  readonly holdsOpenChat: boolean;
  readonly chatCount: number;
}): boolean {
  if (input.chatCount === 0) return false;
  if (input.choice === "open") return true;
  if (input.choice === "closed") return false;
  return input.holdsOpenChat;
}

/** The chevron flips what the person sees now. */
export function toggledFoldChoice(unfoldedNow: boolean): "open" | "closed" {
  return unfoldedNow ? "closed" : "open";
}

/**
 * Where a click on an assistant's row goes. Uno not set up yet: its first-run
 * screen (`/assistants?view=uno-setup&env=…`) instead of the Set up dialog
 * every time (audit 27.10, line 15). Another assistant not set up: its setup.
 */
export type AssistantRowTarget =
  | { readonly kind: "uno-setup"; readonly environmentId: string }
  | { readonly kind: "setup" }
  | { readonly kind: "chat" };

export function assistantRowTarget(input: {
  readonly configured: boolean;
  readonly isUno: boolean;
  readonly teamShown: boolean;
  readonly environmentId: string;
}): AssistantRowTarget {
  if (input.configured) return { kind: "chat" };
  if (input.isUno && input.teamShown) {
    return { kind: "uno-setup", environmentId: input.environmentId };
  }
  return { kind: "setup" };
}

/** The address of Uno's first-run screen (the assistants page draws it). */
export function unoSetupHref(environmentId: string): string {
  return `/assistants?${new URLSearchParams({ view: "uno-setup", env: environmentId })}`;
}

/**
 * The small line after an assistant's name: its role, and the computer it
 * lives on when that is not the account's home computer (where Uno and the
 * personas live) and the person has more than one.
 */
export function assistantRowNote(input: {
  readonly isUno: boolean;
  readonly role: string | null;
  readonly environmentId: string;
  readonly homeEnvironmentId: string | null;
  readonly computerLabel: string;
  readonly multiComputer: boolean;
}): { readonly text: string; readonly computer: string | null } {
  const role = input.isUno ? "Everything" : (input.role ?? "");
  const elsewhere =
    input.multiComputer &&
    !input.isUno &&
    input.homeEnvironmentId !== null &&
    input.environmentId !== input.homeEnvironmentId &&
    input.computerLabel !== "";
  if (!elsewhere) return { text: role, computer: null };
  return {
    text: role ? `${role} · ${input.computerLabel}` : input.computerLabel,
    computer: input.computerLabel,
  };
}
