/**
 * When a `uno-work` tool asks the person first.
 *
 * Every tool declares how much it touches:
 * - `safe`      — reads, or only shows/tells the person something (notify,
 *                 open in the panel, ask for a secret). Always runs.
 * - `change`    — changes this computer or starts work (start/stop an app,
 *                 write a manifest, start a chat). Follows the chat's mode
 *                 like any other tool: in Ask mode ("approval-required") the
 *                 person allows it first; in the other modes it runs.
 * - `sensitive` — exposes something to the internet, deletes, or creates
 *                 something billable (show an app on the internet, share
 *                 link, publish a site, remove an app, create a computer).
 *                 Always asks, whatever the mode.
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
): UnoWorkGateDecision {
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
