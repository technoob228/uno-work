/**
 * What an assistant is responsible for and its own rules, as one block of its
 * session's stable system prompt (Hermes `agent.environment_hint`, next to
 * SOUL/USER/NOTES — `provider/acp/hermesHandoff.ts`): its standing duties,
 * its email rules and where it works. The source is its team record
 * (`team.json`, the person edits it on its page or it saves its setup
 * answers), so a status or dispatch turn needs no tool call to know them.
 *
 * Pure: no I/O.
 *
 * @module assistants/profileHint
 */
import type { ManagerAssistantTeam } from "@t3tools/contracts";
import { mailPolicyLine } from "@t3tools/shared/assistantMail";

export const ASSISTANT_PROFILE_HINT_CHARS = 3_000;

const WISH: Readonly<Record<NonNullable<ManagerAssistantTeam["worksOnWish"]>, string>> = {
  here: "this computer",
  cloud: "one of their cloud computers",
  own: "a computer of its own",
};

export function assistantProfileBlock(
  team: ManagerAssistantTeam,
  options: { readonly isUno: boolean },
): string | null {
  const lines: string[] = [];
  if (team.duties.length > 0) {
    lines.push(
      "Always on you — your standing duties (the person set them; keep doing them without being asked, and say so when one needs them):",
      ...team.duties.map((duty) => `- ${duty}`),
    );
  }
  if (team.roles.length > 0) lines.push(`Your role: ${team.roles.join(", ")}.`);
  lines.push(
    team.mail.enabled
      ? `Your own email (where this computer has it — mail_address tells and gives your address): ${mailPolicyLine(team.mail, null)}.`
      : "Your own email is off (the person's choice): don't send mail any other way.",
  );
  if (!options.isUno && team.worksOnWish !== null && team.worksOnWish !== "here") {
    lines.push(
      `The person wants you to work on ${WISH[team.worksOnWish]}; until they move you (their click on your page, Works on) you work on this computer.`,
    );
  }
  const body = lines.join("\n").trim();
  if (body.length === 0) return null;
  return body.length > ASSISTANT_PROFILE_HINT_CHARS
    ? `${body.slice(0, ASSISTANT_PROFILE_HINT_CHARS)}\n[…]`
    : body;
}
