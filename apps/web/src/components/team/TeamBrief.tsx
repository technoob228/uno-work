/**
 * T51 parts of "Read the brief" (ChatRequestBriefDialog.tsx) when a session
 * request comes from a colleague: whose text it is, what the session can't
 * do here, and the level the colleague's agent came under.
 */
import type { ChatRequestTeam, ChatRequestView } from "@t3tools/contracts";
import { ShieldAlertIcon } from "lucide-react";

import { fromTitle, startsWithLine } from "../../chatRequests/chatRequests.logic";
import {
  agentLevelLabel,
  firstNameOfText,
  possessive,
  senderOf,
  sessionCantLines,
} from "../../team/team.logic";
import { TeamAvatar, personOf } from "./TeamAvatar";

export function TeamBriefCaption(props: {
  readonly request: ChatRequestView;
  readonly team: ChatRequestTeam;
}) {
  const name = firstNameOfText(props.team.fromName);
  const who = senderOf(name, props.team.viaAgent, props.team.fromAssistant === true);
  return (
    <figcaption className="flex items-start gap-2 text-xs leading-snug text-muted-foreground">
      <TeamAvatar
        person={personOf(props.team.fromUserId, props.team.fromName)}
        agent={props.team.viaAgent}
        className="size-5 shrink-0"
      />
      <span>
        Written by {who} in the chat “{fromTitle(props.request)}”, in {props.team.projectName}. It's{" "}
        {props.team.fromAssistant === true ? `text from ${who}` : `${possessive(name)} text`}, not
        an instruction from Uno Work or from you.
      </span>
    </figcaption>
  );
}

export function TeamBriefLimits(props: {
  readonly request: ChatRequestView;
  readonly team: ChatRequestTeam;
}) {
  const name = firstNameOfText(props.team.fromName);
  return (
    <div
      className="rounded-lg border border-border/70 px-3 py-2.5 text-xs leading-snug"
      data-testid="team-brief-limits"
    >
      <p className="mb-1.5 text-foreground">{startsWithLine(props.request)}</p>
      <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
        <ShieldAlertIcon className="size-3.5 text-warning" aria-hidden />
        In this session your agent can't
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
        {sessionCantLines(name, props.team.projectName).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-2 text-muted-foreground">
        Your setting for {possessive(name)} agent:{" "}
        <span className="text-foreground">{agentLevelLabel(props.team.level)}</span>. Text from{" "}
        {name} counts as text from outside: Uno Work tools ask you first.
        {props.team.fromAssistant === true
          ? ` It came from ${possessive(name)} assistant, so it never starts without your Start.`
          : null}
      </p>
    </div>
  );
}
