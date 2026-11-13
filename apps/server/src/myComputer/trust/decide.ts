/**
 * What happens to one call on the person's computer, from its tier and the
 * chat: it runs, it asks the person, or it is refused. Plain code, no I/O.
 *
 * - `free` runs in every mode (reading in allowed folders, checks, one
 *   package's tests, the agents' own browser, the simulator);
 * - `chat` runs once the chat holds an Allow (one Allow covers it for
 *   `grantHours`); without one it asks, and that Allow becomes the chat's.
 *   Full access runs it; "edits run freely" runs file writes;
 * - `ask` asks every time; full access runs it;
 * - `always` asks every time, full access too;
 * - `blocked` is refused (containers, full runs): the agent hears where to
 *   run it instead.
 *
 * On top: a Cautious assistant and a chat with a stranger's text run only
 * `free` reads and ask for everything else each time (no chat Allow: the
 * person sees every step). Stopped by the person: everything is refused
 * until they resume. Paused for idleness: the next call asks, and Allow
 * resumes.
 *
 * @module myComputer/trust/decide
 */
import type { MyComputerPause, MyComputerTier, RuntimeMode } from "@t3tools/contracts";

/** What the call does there: `read` also covers listing and searching. */
export type TrustOpKind = "read" | "write" | "run";

export interface TrustDecisionInput {
  readonly tier: MyComputerTier;
  readonly reason: string;
  readonly kind: TrustOpKind;
  readonly runtimeMode: RuntimeMode;
  /** The chat's assistant is Cautious. */
  readonly cautious: boolean;
  /** The chat holds text from outside Uno. */
  readonly outsideText: boolean;
  /** The chat holds an unexpired Allow for this computer. */
  readonly grantActive: boolean;
  readonly paused: MyComputerPause | null;
  readonly grantHours: number;
}

export type TrustDecision =
  | { readonly verdict: "run" }
  | {
      readonly verdict: "ask";
      /** Allow gives the chat its grant. */
      readonly grant: boolean;
      /** Allow lifts the idle pause. */
      readonly resume: boolean;
      /** For the card: why it asks. */
      readonly note: string;
      /** Asks whatever the mode: the card says so. */
      readonly sensitive: boolean;
    }
  | { readonly verdict: "refuse"; readonly message: string };

export const STOPPED_MESSAGE =
  "The person stopped all agents on their computers. Nothing runs there until they resume it in Settings → My computer. Tell them; don't try another way.";

export function decideTrust(input: TrustDecisionInput): TrustDecision {
  const { tier } = input;
  if (input.paused?.reason === "stopped") return { verdict: "refuse", message: STOPPED_MESSAGE };
  if (tier === "blocked") return { verdict: "refuse", message: input.reason };
  const resume = input.paused?.reason === "idle";
  const ask = (grant: boolean, note: string): TrustDecision => ({
    verdict: "ask",
    grant,
    resume,
    note: resume ? `Agents' access paused after a quiet spell; Allow resumes it. ${note}` : note,
    sensitive: tier === "always",
  });

  if (input.cautious || input.outsideText) {
    if (tier === "free" && input.kind === "read" && !resume) return { verdict: "run" };
    return ask(false, `Asks every time in this chat: ${input.reason}.`);
  }
  switch (tier) {
    case "free":
      return resume ? ask(false, `${capital(input.reason)}.`) : { verdict: "run" };
    case "chat": {
      const runs =
        input.grantActive ||
        input.runtimeMode === "full-access" ||
        (input.runtimeMode === "auto-accept-edits" && input.kind === "write");
      if (runs && !resume) return { verdict: "run" };
      return ask(
        !input.grantActive,
        `${capital(input.reason)}. One Allow covers this chat for ${input.grantHours} h: writing in allowed folders, git without push, allowed commands.`,
      );
    }
    case "ask":
      if (input.runtimeMode === "full-access" && !resume) return { verdict: "run" };
      return ask(false, `Asks every time: ${input.reason}.`);
    case "always":
      return ask(false, `Always asks, whatever the chat's mode: ${input.reason}.`);
  }
}

const capital = (text: string) => (text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text);
