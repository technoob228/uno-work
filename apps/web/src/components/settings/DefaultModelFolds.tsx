/**
 * What folds inside Settings → AI → "Default model" (13.11 v2, Misha: "one
 * setting, not five"): the rows by kind of task of each assistant on this
 * computer (its ROUTING.md), and — in Advanced — what the assistant itself
 * replies with (Hermes' AI), which connects to an AI on its own and so is
 * chosen apart from the default model (its picker: "Assistant replies",
 * DefaultModelRoles.tsx).
 *
 * @module components/settings/DefaultModelFolds
 */
import { ASSISTANT_PROJECT_ID, type EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useAssistantLlm } from "../../assistant/useAssistantLlm";
import { cn } from "../../lib/utils";
import { AssistantPowerPicker } from "../assistant/AssistantPowerPicker";
import { KindOfTaskTable } from "../assistants/AssistantMemoryModels";
import { useAssistantTeam, useTeamShown } from "../assistants/useAssistantTeam";

/** Folds open from a link ("Settings → AI → Default model → Advanced"). */
export const DEFAULT_MODEL_FOLD_HASH = {
  kindOfTask: "by-kind-of-task",
  advanced: "assistant-ai",
} as const;

function Fold(props: {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && window.location.hash.includes(`fold=${props.id}`),
  );
  return (
    <details
      id={props.id}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="border-t border-border/60 py-2.5"
      data-testid={`default-model-fold-${props.id}`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="font-medium text-foreground">{props.title}</span>
        <span className="truncate text-muted-foreground">· {props.hint}</span>
      </summary>
      {open ? <div className="pt-2.5 pl-5">{props.children}</div> : null}
    </details>
  );
}

function KindOfTaskFold({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const team = useAssistantTeam();
  const teamShown = useTeamShown();
  // Each assistant on this computer has its own rows; Uno first.
  const here = useMemo(
    () =>
      teamShown
        ? team
            .filter((member) => member.environmentId === environmentId && !member.revoked)
            .toSorted((a, b) => Number(b.isUno) - Number(a.isUno))
        : [],
    [team, teamShown, environmentId],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const current =
    here.find((member) => member.projectId === picked) ?? here.find((member) => member.isUno);
  const name = current?.profile.name ?? "Uno";
  const projectId = current?.projectId ?? ASSISTANT_PROJECT_ID;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        A row you set here beats the default model for that kind of task. Rows marked Starting point
        or Learned are {name}'s own and apply only on Auto.
      </p>
      {here.length > 1 ? (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Whose rows">
          {here.map((member) => (
            <button
              key={member.projectId}
              type="button"
              role="tab"
              aria-selected={member.projectId === projectId}
              onClick={() => setPicked(member.projectId)}
              className={cn(
                "h-6 cursor-pointer rounded-full border px-2.5 text-xs",
                member.projectId === projectId
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {member.profile.name}
            </button>
          ))}
        </div>
      ) : null}
      <KindOfTaskTable
        key={projectId}
        name={name}
        environmentId={environmentId}
        projectId={projectId}
      />
    </div>
  );
}

export function DefaultModelFolds({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const llm = useAssistantLlm(environmentId);
  return (
    <div className="mt-3 -mx-4 px-4 sm:-mx-5 sm:px-5">
      <Fold
        id={DEFAULT_MODEL_FOLD_HASH.kindOfTask}
        title="By kind of task"
        hint="a different model for UI, bugs, reading code…"
      >
        <KindOfTaskFold environmentId={environmentId} />
      </Fold>
      {llm.supported ? (
        <Fold
          id={DEFAULT_MODEL_FOLD_HASH.advanced}
          title="Advanced"
          hint="how your assistant connects to its AI"
        >
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Your assistant talks to its AI directly, not through Claude Code or Codex, so its own
              replies ("Assistant replies" above) can run on Uno AI, your own plan or a key; the
              work it hands out runs on the models above.
            </p>
            <AssistantPowerPicker
              environmentId={environmentId}
              note="One choice for every assistant on this computer. Uno AI is in your plan; with your own plan or key Uno doesn't charge."
            />
          </div>
        </Fold>
      ) : null}
    </div>
  );
}
