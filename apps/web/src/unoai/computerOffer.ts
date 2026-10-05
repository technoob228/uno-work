/**
 * The card in a Uno AI chat (no computer yet) when the request needs one: a
 * bot, a backend, an assistant that stays on.
 *
 * Small is a bare server for the person's own agent: Uno doesn't build there
 * (decision 02.10). The card used to say "This needs your own computer" with
 * only "See plans" to someone who had just paid for Small (live walkthrough
 * 05.10.2026, WG-02) — now it says so plainly and offers both real ways on.
 */
import type { LiteStanding } from "../lite/webLite";

export interface ComputerOfferCopy {
  readonly title: string;
  /** Under the buttons; null keeps the default "this conversation continues there". */
  readonly note: string | null;
  /** The main upgrade button's words. */
  readonly upgradeLabel: string;
  /** "Use my own agent" (Small: the server is for it). */
  readonly ownAgent: boolean;
}

export function computerOfferCopy(standing: LiteStanding | null): ComputerOfferCopy {
  if (standing === "small") {
    return {
      title: "Uno builds this on Plus",
      note: "Your Small server runs what you or your own agent (Claude Code, Codex, Cursor) put on it: Uno doesn't build there. On Plus, Uno builds it for you and this conversation continues there.",
      upgradeLabel: "Upgrade to Plus",
      ownAgent: true,
    };
  }
  return {
    title: "This needs your own computer",
    note: null,
    upgradeLabel: standing === "other" ? "Upgrade to Plus" : "See plans",
    ownAgent: false,
  };
}
