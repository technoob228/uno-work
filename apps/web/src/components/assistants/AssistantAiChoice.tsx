/**
 * The one place an assistant's AI is chosen (audit 27.10 #13: it was in three
 * places with three different texts — the Set up modal, Settings and the
 * assistant's page). Uno's first-run screen, a new assistant's setup, its
 * page and the setup modals all show this: the same cards
 * (`AssistantPowerPicker`), the same heading and the same honest line —
 * today it is one choice per computer, for every assistant on it.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { AssistantPowerPicker } from "../assistant/AssistantPowerPicker";

/** The heading over the cards, for one assistant. */
export function aiChoiceHeading(name: string): string {
  return `What ${name.trim() || "it"} thinks with`;
}

/** The line under the cards: what the choice covers, and what it costs. */
export function aiChoiceNote(computer: string): string {
  return `One choice for every assistant on ${computer.trim() || "this computer"}. Uno AI is in your plan; with your own plan or key Uno doesn't charge.`;
}

export function AssistantAiChoice(props: {
  readonly environmentId: EnvironmentId | string;
  /** The assistant's name for the heading; no heading when absent. */
  readonly name?: string;
  /** Its computer's name for the note ("uno-work", "MacBook"). */
  readonly computer: string;
  /** One card per row (narrow places: its page). */
  readonly narrow?: boolean;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2", props.className)} data-testid="assistant-ai-choice">
      {props.name !== undefined ? (
        <div className="text-sm font-semibold">{aiChoiceHeading(props.name)}</div>
      ) : null}
      <AssistantPowerPicker
        environmentId={props.environmentId as EnvironmentId}
        note={aiChoiceNote(props.computer)}
        {...(props.narrow ? { className: "[&_[role=radiogroup]]:grid-cols-1" } : {})}
      />
    </div>
  );
}
