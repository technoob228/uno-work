/**
 * When a `uno-work` tool asks the person first.
 *
 * Every tool declares how much it touches:
 * - `safe`      — reads, or only shows/tells the person something (notify,
 *                 open in the panel, ask for a secret). Always runs.
 * - `change`    — changes this computer or starts work (start/stop an app,
 *                 write a manifest, start a chat, send a letter from the
 *                 agent's own mailbox). Follows the chat's mode
 *                 like any other tool: in Ask mode ("approval-required") the
 *                 person allows it first; in the other modes it runs.
 * - `sensitive` — exposes something beyond a plain site, deletes, or creates
 *                 something billable (show an app on the internet, share
 *                 link, remove a site's password, form answers to an outside
 *                 URL, unpublish a site, remove an app, create a computer or
 *                 a database). Always asks, whatever the mode.
 *
 * Publishing a plain static site is `safe` (decision 02.10): it goes up
 * without an Allow, and Unpublish is one click in Apps & sites. Setting a
 * site's password and sending form answers to email or Telegram are `safe`
 * too. Reading the agent's own mailbox and saving an attachment into
 * `~/Downloads/mail/` are `safe`; sending (`mail_send`) is a `change`
 * (spec 20.10: asks in Ask mode).
 *
 * An assistant in "Asks first" mode (Misha 23.10) adds one rule on top:
 * every call that acts outward (`asksFirstCategory` in
 * `@t3tools/shared/assistantPreset`: email out, sites, putting things on the
 * internet, share links, deleting, creating databases / computers /
 * assistants, writes to connected apps) asks, whatever the level and mode.
 *
 * The gate lives in the daemon, not in each harness, so Claude, Codex,
 * OpenCode, Uno, Cursor, Hermes and any custom ACP harness behave the same.
 */
import type { RuntimeMode } from "@t3tools/contracts";

export type UnoWorkToolLevel = "safe" | "change" | "sensitive";

export type UnoWorkGateDecision = "run" | "ask";

export function decideUnoWorkGate(
  level: UnoWorkToolLevel,
  runtimeMode: RuntimeMode,
  /** The call acts outward and the chat's assistant is in "Asks first" mode. */
  asksFirstOutward = false,
): UnoWorkGateDecision {
  if (asksFirstOutward) return "ask";
  switch (level) {
    case "safe":
      return "run";
    case "change":
      return runtimeMode === "approval-required" ? "ask" : "run";
    case "sensitive":
      return "ask";
  }
}

/** What the model reads when the person didn't allow a call. */
export function refusalMessage(outcome: "denied" | "timeout" | "no_client", title: string): string {
  switch (outcome) {
    case "denied":
      return `The person declined: "${title}". Don't retry it and don't work around it (no shell or curl equivalent); ask them what they'd like instead.`;
    case "timeout":
      return `Nobody answered the approval for "${title}" in time. Tell the person what you wanted to do and that it needs their Allow; don't retry in a loop.`;
    case "no_client":
      return `"${title}" needs the person's Allow, but Uno Work isn't open anywhere to ask them. Tell them what you want to do; they can allow it when they're back.`;
  }
}
