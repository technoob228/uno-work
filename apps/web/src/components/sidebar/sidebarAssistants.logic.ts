/**
 * The assistants block at the top of the sidebar (Misha 23.10): with the
 * team on the account, a small "Assistants" header with "+" — always there,
 * however many assistants there are (it used to vanish with the second one).
 * Without the team it is Uno alone: no header, no "+".
 *
 * Pure.
 */
export interface AssistantsHeaderState {
  /** The "Assistants" label row. */
  readonly showHeader: boolean;
  /** "+" next to it: one click makes an assistant. */
  readonly showCreate: boolean;
}

export function assistantsHeaderState(input: {
  readonly teamShown: boolean;
}): AssistantsHeaderState {
  return { showHeader: input.teamShown, showCreate: input.teamShown };
}
