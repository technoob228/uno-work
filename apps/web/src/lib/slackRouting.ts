/**
 * What the Slack card says when several computers — of this account or of
 * several Uno accounts — answer in one workspace (console 257, decisions
 * 21.10). Direct messages and @mentions outside taken channels go to the
 * account's default computer: the one the person picked, else the cloud
 * computer; each channel answers on the computer that took it.
 *
 * @module lib/slackRouting
 */
import type { ManagerSlackRoutingStatus } from "@t3tools/contracts";

export interface SlackRoutingCopy {
  /** Who answers direct messages; null with one computer only. */
  readonly directLine: string | null;
  /** "here": make this computer the default; "undo": back to the rule. */
  readonly action: { readonly kind: "here" | "undo"; readonly label: string } | null;
  /** Other Uno accounts in the workspace; null when it's only this account. */
  readonly sharedLine: string | null;
}

export function slackRoutingCopy(routing: ManagerSlackRoutingStatus | undefined): SlackRoutingCopy {
  if (routing === undefined) return { directLine: null, action: null, sharedLine: null };
  const sharedLine = routing.shared
    ? routing.signedAs !== null
      ? `Other Uno accounts use Uno in this workspace too. Replies from here are signed “${routing.signedAs}”, and this computer sees only its own channels and messages.`
      : "Other Uno accounts use Uno in this workspace too. This computer sees only its own channels and messages."
    : null;
  if (routing.computers.length < 2) return { directLine: null, action: null, sharedLine };
  if (routing.isDefault) {
    return {
      directLine:
        "Your direct messages and @mentions outside chosen channels come to this computer.",
      action: routing.defaultChosen
        ? { kind: "undo", label: "Send them to the cloud computer" }
        : null,
      sharedLine,
    };
  }
  const target = routing.computers.find((computer) => computer.isDefault);
  return {
    directLine: `Your direct messages and @mentions outside chosen channels go to ${target?.name ?? "your other computer"}.`,
    action: { kind: "here", label: "Answer them here" },
    sharedLine,
  };
}
