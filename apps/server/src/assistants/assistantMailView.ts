/**
 * An assistant's own email as its page shows it (`GET
 * /api/manager/assistant/mail`): its address in the computer's mailbox, its
 * rules, how many it sent today and its newest letters — only its own, the
 * same filter its `mail_*` tools use (`@t3tools/shared/assistantMail`).
 *
 * Pure: the mailbox state, the letters and the ledger are read by the caller.
 *
 * @module assistants/assistantMailView
 */
import {
  ASSISTANT_PROJECT_ID,
  type ManagerAssistantMailLetter,
  type ManagerAssistantMailView,
  type ManagerAssistantTeam,
} from "@t3tools/contracts";
import { assistantMailAddress, mailBelongsTo } from "@t3tools/shared/assistantMail";

import type { AgentMailListedLetter, AgentMailState } from "../setupTools/agentMail.ts";
import { type MailLedger, sentOn } from "./mailLedger.ts";

/** How many letters the page shows. */
export const ASSISTANT_PAGE_LETTERS = 5;

export function assistantMailView(input: {
  readonly projectId: string;
  readonly state: AgentMailState;
  readonly letters: ReadonlyArray<AgentMailListedLetter>;
  readonly team: ManagerAssistantTeam;
  readonly ledger: MailLedger;
  readonly ownerEmail: string | null;
  readonly now: Date;
}): ManagerAssistantMailView {
  const mailbox = input.state.available ? input.state.mailbox : null;
  if (mailbox === null) {
    return {
      available: false,
      reason: input.state.reason ?? "not_enabled",
      address: null,
      computerAddress: null,
      policy: input.team.mail,
      ownerEmail: input.ownerEmail,
      sentToday: 0,
      letters: [],
    };
  }
  const isUno = input.projectId === ASSISTANT_PROJECT_ID;
  const address = assistantMailAddress(mailbox.address, input.projectId);
  const own = { isUno, address, sentIds: new Set(input.ledger.sentIds) };
  const letters: ManagerAssistantMailLetter[] = input.letters
    .filter((letter) => mailBelongsTo(letter, own))
    .slice(0, ASSISTANT_PAGE_LETTERS)
    .map((letter) => ({
      id: letter.id,
      direction: letter.direction,
      from: letter.from,
      to: [...letter.to],
      subject: letter.subject,
      snippet: letter.snippet,
      receivedAt: letter.receivedAt,
      read: letter.read,
      suspicious: letter.suspicious,
    }));
  return {
    available: true,
    reason: null,
    address,
    computerAddress: mailbox.address,
    policy: input.team.mail,
    ownerEmail: input.ownerEmail,
    sentToday: sentOn(input.ledger, input.now),
    letters,
  };
}
