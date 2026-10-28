/**
 * "Automations" on an assistant's page (Uno's and a persona's): what it does
 * on a schedule or when something happens, with a card each and "New
 * automation". On a laptop it says they run on a cloud computer; with the
 * feature off for the account the section isn't there at all.
 */
import type { Automation } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CloudIcon, LoaderCircleIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Section } from "../assistants/AssistantProfileParts";
import type { TeamMember } from "../assistants/useAssistantTeam";
import { Button } from "../ui/button";
import { AutomationCard } from "./AutomationCard";
import { AutomationDialog, type AutomationAssistantChoice } from "./AutomationDialog";
import { emptyHint, unavailableLine } from "./automations.logic";
import { useAutomationsOn } from "./useAutomations";

export function choiceOfMember(
  member: TeamMember,
  available = true,
  note: string | null = null,
): AutomationAssistantChoice {
  return {
    environmentId: member.environmentId,
    projectId: member.projectId,
    name: member.profile.name,
    computer: member.computerLabel || "its computer",
    asksFirst: member.profile.preset !== "full",
    available,
    note,
  };
}

export function AutomationsSection(props: { readonly member: TeamMember }) {
  const { member } = props;
  const navigate = useNavigate();
  const list = useAutomationsOn(member.environmentId);
  const [dialog, setDialog] = useState<null | { automation: Automation | null }>(null);
  const name = member.profile.name;
  const data = list.data;

  if (list.isLoading) {
    return (
      <Section title="Automations" testId="assistant-automations">
        <p className="flex items-center gap-1.5 px-3 py-2.5 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3 animate-spin" /> Asking its computer…
        </p>
      </Section>
    );
  }
  if (list.error) {
    return (
      <Section title="Automations" testId="assistant-automations">
        <p className="px-3 py-2.5 text-xs text-muted-foreground">
          Couldn't load the automations — its computer didn't answer.
        </p>
      </Section>
    );
  }
  if (!data) return null;
  if (!data.available) {
    const line = unavailableLine(data.reason);
    if (!line) return null;
    return (
      <Section title="Automations" testId="assistant-automations">
        <div
          className="flex items-start gap-2 px-3 py-2.5 text-xs"
          data-testid="assistant-automations-unavailable"
          data-reason={data.reason ?? ""}
        >
          <CloudIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-muted-foreground">{line}</span>
          {data.reason === "not_cloud_computer" ? (
            <button
              type="button"
              onClick={() => void navigate({ to: "/my-uno" })}
              className="shrink-0 cursor-pointer text-primary hover:underline"
            >
              Get one
            </button>
          ) : null}
        </div>
      </Section>
    );
  }

  const own = data.automations.filter((item) => item.assistant === member.projectId);
  return (
    <Section
      title={own.length > 0 ? `Automations · ${own.length}` : "Automations"}
      testId="assistant-automations"
      action={
        member.revoked ? null : (
          <button
            type="button"
            onClick={() => setDialog({ automation: null })}
            className="inline-flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline"
            data-testid="assistant-automations-new"
          >
            <PlusIcon className="size-3" /> New automation
          </button>
        )
      }
    >
      {own.length === 0 ? (
        <div
          className="flex flex-col items-start gap-2 px-3 py-3"
          data-testid="assistant-automations-empty"
        >
          <p className="text-xs text-muted-foreground">
            Nothing yet. {name} can do things on a schedule or when something happens.{" "}
            {emptyHint(name)}
          </p>
          {member.revoked ? null : (
            <Button size="xs" variant="outline" onClick={() => setDialog({ automation: null })}>
              <PlusIcon className="size-3" /> New automation
            </Button>
          )}
        </div>
      ) : (
        own.map((automation) => (
          <AutomationCard
            key={automation.id}
            automation={automation}
            environmentId={member.environmentId}
            computer={member.computerLabel}
            onEdit={() => setDialog({ automation })}
          />
        ))
      )}
      <AutomationDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        choices={[choiceOfMember(member)]}
        automation={dialog?.automation ?? null}
        automationEnvironmentId={member.environmentId}
      />
    </Section>
  );
}
