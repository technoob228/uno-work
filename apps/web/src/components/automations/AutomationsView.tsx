/**
 * Automations (28.10): everything the assistants do by themselves, on every
 * connected computer — grouped by assistant, with "New automation" and a
 * choice of who does it. The same cards as on an assistant's page.
 */
import type { Automation } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CloudIcon,
  LoaderCircleIcon,
  PlusIcon,
  WorkflowIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AssistantAvatar, avatarImageOf } from "../assistants/AssistantAvatar";
import { type TeamMember, useAssistantTeam } from "../assistants/useAssistantTeam";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { AutomationCard } from "./AutomationCard";
import { AutomationDialog } from "./AutomationDialog";
import { choiceOfMember } from "./AutomationsSection";
import { emptyHint, groupByAssistant, unavailableLine } from "./automations.logic";
import { useAutomationsAcross } from "./useAutomations";

export interface AutomationsRouteSearch {
  /** Light up this one (the "Open" of the chat card). */
  readonly id?: number;
}

export function parseAutomationsSearch(search: Record<string, unknown>): AutomationsRouteSearch {
  const id = Number(search["id"]);
  return Number.isInteger(id) && id > 0 ? { id } : {};
}

export function AutomationsView(props: { readonly search: AutomationsRouteSearch }) {
  const navigate = useNavigate();
  const team = useAssistantTeam();
  const members = useMemo(() => team.filter((member) => !member.revoked), [team]);
  const environmentIds = useMemo(
    () => [...new Set(members.map((member) => member.environmentId))].toSorted(),
    [members],
  );
  const computers = useAutomationsAcross(environmentIds);
  const [dialog, setDialog] = useState<null | {
    automation: Automation | null;
    environmentId: string | null;
  }>(null);

  const byEnv = new Map(computers.map((computer) => [computer.environmentId, computer]));
  const labelOf = (environmentId: string) =>
    members.find((member) => member.environmentId === environmentId)?.computerLabel ||
    "its computer";
  const items = computers.flatMap((computer) =>
    (computer.data?.available ? computer.data.automations : []).map((automation) => ({
      environmentId: computer.environmentId,
      automation,
    })),
  );
  const groups = groupByAssistant(items, members);
  const loading = computers.some((computer) => computer.loading);
  const choices = members.map((member) => {
    const data = byEnv.get(member.environmentId)?.data;
    const available = data?.available === true;
    return choiceOfMember(
      member,
      available,
      available
        ? null
        : data?.reason === "not_cloud_computer"
          ? "runs on a laptop"
          : "not available",
    );
  });
  const anyAvailable = choices.some((choice) => choice.available);
  const laptops = computers.filter(
    (computer) =>
      computer.data && !computer.data.available && unavailableLine(computer.data.reason),
  );
  const uno = members.find((member) => member.isUno) ?? null;
  const memberOf = (environmentId: string, projectId: string): TeamMember | null =>
    members.find(
      (member) => member.environmentId === environmentId && member.projectId === projectId,
    ) ?? null;

  // The card the chat's "Open" pointed at comes into view.
  const highlight = props.search.id ?? null;
  useEffect(() => {
    if (highlight === null) return;
    document
      .querySelector(`[data-automation="${highlight}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight, items.length]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
        data-testid="automations-view"
      >
        <header className="shrink-0 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-3">
            <SidebarShowButton />
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-600 text-white">
              <WorkflowIcon className="size-4.5" />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-base leading-tight font-semibold">Automations</h1>
              <p className="truncate text-xs text-muted-foreground">
                What your assistants do by themselves — on a schedule or when something happens
              </p>
            </div>
            <Button
              size="sm"
              disabled={!anyAvailable}
              onClick={() => setDialog({ automation: null, environmentId: null })}
              data-testid="automations-new"
            >
              <PlusIcon className="size-3.5" />
              <span className="hidden sm:inline">New automation</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-3 py-5 sm:px-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            {loading && items.length === 0 ? (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-3.5 animate-spin" /> Asking your computers…
              </p>
            ) : null}

            {!loading && groups.length === 0 ? (
              <div
                className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border px-4 py-5"
                data-testid="automations-empty"
              >
                <p className="text-sm font-medium">No automations yet</p>
                <p className="text-sm text-muted-foreground">
                  An assistant can review every pull request, sum up your day at 18:00, or write the
                  follow-up after a call — by itself. {emptyHint(uno?.profile.name ?? "Uno")}
                </p>
                {anyAvailable ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDialog({ automation: null, environmentId: null })}
                  >
                    <PlusIcon className="size-3.5" /> New automation
                  </Button>
                ) : null}
              </div>
            ) : null}

            {groups.map((group) => {
              const member = memberOf(group.environmentId, group.assistant);
              return (
                <section
                  key={group.key}
                  className="flex flex-col gap-2"
                  data-testid="automations-group"
                  data-assistant={group.assistant}
                >
                  <button
                    type="button"
                    disabled={!member}
                    onClick={() =>
                      member
                        ? void navigate({
                            to: "/assistants",
                            search: {
                              view: "profile",
                              env: member.environmentId,
                              project: member.projectId,
                            },
                          })
                        : undefined
                    }
                    className="group flex w-fit cursor-pointer items-center gap-2 px-1 text-left disabled:cursor-default"
                  >
                    {member ? (
                      <AssistantAvatar
                        emoji={member.profile.emoji}
                        tone={member.profile.tone}
                        image={avatarImageOf(member.profile)}
                        className="size-6"
                        emojiClassName="text-sm"
                      />
                    ) : null}
                    <span className="text-sm font-medium">
                      {member?.profile.name ?? group.assistantName}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      · {labelOf(group.environmentId)} · {group.items.length}
                    </span>
                    {member ? (
                      <ChevronRightIcon className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                    ) : null}
                  </button>
                  <div className="rounded-lg border border-border bg-card/40">
                    {group.items.map(({ automation, environmentId }) => (
                      <AutomationCard
                        key={automation.id}
                        automation={automation}
                        environmentId={environmentId}
                        computer={labelOf(environmentId)}
                        highlighted={highlight === automation.id}
                        onEdit={() => setDialog({ automation, environmentId })}
                      />
                    ))}
                  </div>
                </section>
              );
            })}

            {laptops.map((computer) => (
              <p
                key={computer.environmentId}
                className="flex items-start gap-2 px-1 text-xs text-muted-foreground"
                data-testid="automations-unavailable"
              >
                <CloudIcon className="mt-0.5 size-3.5 shrink-0" />
                {labelOf(computer.environmentId)}: {unavailableLine(computer.data!.reason)}
              </p>
            ))}
          </div>
        </div>
      </div>
      <AutomationDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        choices={choices}
        automation={dialog?.automation ?? null}
        automationEnvironmentId={dialog?.environmentId ?? null}
      />
    </SidebarInset>
  );
}
