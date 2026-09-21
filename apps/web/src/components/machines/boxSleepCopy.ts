/**
 * What "Sleep" says before it puts a box to sleep. Pure so the three cases
 * (the machine serving this screen, a machine with chats open here, any other
 * box on the account) are unit-tested.
 */
export interface BoxSleepConfirmCopy {
  readonly title: string;
  readonly body: string;
  /** Extra, louder line when this very screen will go away. */
  readonly warning: string | null;
  readonly confirm: string;
}

export function boxSleepConfirmCopy(input: {
  readonly label: string;
  /** Uno Work on screen right now is served by this box. */
  readonly isThisScreen: boolean;
  /** This app has the machine connected (its chats are listed here). */
  readonly isConnectedHere: boolean;
}): BoxSleepConfirmCopy {
  const base =
    "Everything running on it stops until you wake it: websites, bots, agents and scheduled jobs. " +
    "Files stay exactly where they are, and you don't pay for running time while it sleeps.";
  if (input.isThisScreen) {
    return {
      title: `Put ${input.label} to sleep?`,
      body: base,
      warning:
        "This screen runs on this computer, so it will disconnect. To come back, wake it from the Uno console.",
      confirm: "Sleep and disconnect",
    };
  }
  return {
    title: `Put ${input.label} to sleep?`,
    body: base,
    warning: input.isConnectedHere
      ? "Its chats here will show as offline until you wake it."
      : null,
    confirm: "Sleep",
  };
}
