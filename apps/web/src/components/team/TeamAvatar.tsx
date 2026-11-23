/**
 * A teammate's initials in a circle, the same colour everywhere (from their
 * id); with `agent`, a small bot badge — "this person's agent", never the
 * person.
 */
import { BotIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { initialsOf, personName, toneOf, type PersonTone } from "../../team/team.logic";
import type { TeamPersonRef } from "../../team/teamApi.logic";

const TONES: Record<PersonTone, string> = {
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  emerald: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  amber: "bg-amber-500/20 text-amber-800 dark:text-amber-300",
  sky: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
};

export function TeamAvatar(props: {
  readonly person: TeamPersonRef | null;
  readonly agent?: boolean;
  readonly className?: string;
}) {
  const { person } = props;
  return (
    <span className={cn("relative inline-flex shrink-0", props.className)}>
      <span
        className={cn(
          "inline-flex size-full items-center justify-center rounded-full text-[10px] leading-none font-semibold",
          person ? TONES[toneOf(person.userId)] : "bg-muted text-muted-foreground",
        )}
        aria-hidden
      >
        {person ? initialsOf(personName(person)) : "?"}
      </span>
      {props.agent ? (
        <span className="absolute -right-1 -bottom-1 inline-flex size-3.5 items-center justify-center rounded-full bg-background ring-1 ring-border">
          <BotIcon className="size-2.5 text-info" aria-hidden />
        </span>
      ) : null}
    </span>
  );
}

/** By a name only (a T50 record from a colleague carries their id and name). */
export const personOf = (userId: number, name: string): TeamPersonRef => ({
  userId,
  email: name.includes("@") ? name : null,
  username: name,
});
