/**
 * The assistant's page on real data (22.10): the parts of the prototype's
 * page (`AssistantProfilePage.tsx`, w0138 p7) that read and change what its
 * computer keeps — what it may do and its projects (its token), the AI it
 * runs on (one per computer), where you talk (its bot or Slack), what apps it
 * may use (`apps.json`), its routines (the console's schedules). The mock
 * keeps its own versions of these blocks.
 *
 * What isn't built yet says so in one line: a Uno bot of its own for each
 * assistant. Who it is, its duties, its own email and where it works are in
 * `AssistantProfileBlocks.tsx`.
 */
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ASSISTANT_PRESET_COPY } from "@t3tools/shared/assistantPreset";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  CloudIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  SendIcon,
  SlackIcon,
} from "lucide-react";
import { useState } from "react";

import { useAssistantLlm } from "../../assistant/useAssistantLlm";
import { listAssistantSchedules } from "../../lib/assistantsConsoleApi";
import {
  listProjectsForAccessPicker,
  putAssistantApps,
  setAssistantPreset,
} from "../../lib/managerApi";
import { useStore } from "../../store";
import type { MachineRow } from "../settings/machineRows";
import { cardOf } from "../assistant/AssistantPowerPicker";
import { ConnectChannelDialog, type ConnectChannel } from "../assistant/ConnectChannelDialog";
import { AssistantAiChoice, aiChoiceNote } from "./AssistantAiChoice";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useEnvironmentSupportsAssistantSandbox } from "../../environments/assistantChatSupport";
import { useOwnBoxId } from "./useAssistants";
import { AssistantPresetPicker } from "./AssistantPresetPicker";
import {
  type PresetForm,
  presetAccessFromForm,
  presetFormFromToken,
  samePresetForm,
} from "./assistantPreset.logic";
import { type AssistantAccess, BRAIN_NAME } from "./assistantTeam.logic";
import { describeCron, workspaceFromCommand } from "./assistantTemplates";
import { TeammateAccess } from "./TeammateAccess";
import type { TeamMember } from "./useAssistantTeam";
import { appPermissionsOf, daemonLossLine } from "./teamFromDaemon.logic";
import { useTeamActions } from "./useTeamActions";

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** The settings page of this assistant on its computer (Telegram, Slack, memory files). */
export function useOpenAssistantSettings() {
  const navigate = useNavigate();
  return (member: Pick<TeamMember, "environmentId" | "projectId" | "isUno">) => {
    const store = useStore.getState();
    if (store.activeEnvironmentId !== member.environmentId) {
      store.setActiveEnvironmentId(member.environmentId as EnvironmentId);
    }
    void navigate({
      to: "/assistants",
      search: member.isUno ? { view: "card" } : { view: "local", project: member.projectId },
    });
  };
}

// ── What it may do ────────────────────────────────────────────────────────

/** Full / Helper / Observer and its projects — its token, cut down what it set up. */
export function TeamPresetEditor(props: {
  readonly member: TeamMember;
  readonly nameOf: (projectId: string) => string;
  /** Its projects alone; its permission level has its own switch on the page (29.10). */
  readonly projectsOnly?: boolean;
}) {
  const { member } = props;
  const actions = useTeamActions();
  const name = member.profile.name;
  const projects = useQuery({
    queryKey: ["uno-assistant", "access-projects", member.environmentId],
    queryFn: () =>
      listProjectsForAccessPicker({ environmentId: member.environmentId as EnvironmentId }),
    retry: false,
  });
  const sandbox = useEnvironmentSupportsAssistantSandbox(member.environmentId);
  const current = presetFormFromToken(member.summary?.token);
  const [draft, setDraft] = useState<PresetForm | null>(null);
  const [saving, setSaving] = useState(false);
  const form = draft ?? current;
  const dirty = draft !== null && !samePresetForm(draft, current);

  const save = async () => {
    setSaving(true);
    try {
      const result = await setAssistantPreset({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId,
        ...presetAccessFromForm(form),
      });
      await actions.refresh();
      setDraft(null);
      const losses = daemonLossLine(result.losses ?? [], props.nameOf);
      toastManager.add({
        type: "success",
        title: props.projectsOnly
          ? `${name}: where it can look is saved`
          : `${name} is ${ASSISTANT_PRESET_COPY[form.preset].name} now`,
        description: losses
          ? `${losses}. It's in Needs you too.`
          : "It follows this from its next step.",
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't change what it may do",
        description: errorText(cause, "Its computer didn't answer."),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <AssistantPresetPicker
        sandbox={sandbox}
        name={name}
        value={form}
        onChange={setDraft}
        projects={projects.data ?? []}
        disabled={saving || member.revoked}
        projectsOnly={props.projectsOnly ?? false}
        testId="assistant-profile-preset"
      />
      {dirty ? (
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            onClick={() => void save()}
            disabled={saving}
            data-testid="assistant-profile-preset-save"
          >
            {saving ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
            Save
          </Button>
          <Button size="xs" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
            Cancel
          </Button>
          <span className="text-xs text-muted-foreground">
            Assistants {name} set up are cut to match.
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ── What it runs on ───────────────────────────────────────────────────────

export function TeamRunsOn(props: { readonly member: TeamMember; readonly changing: boolean }) {
  const { member } = props;
  const llm = useAssistantLlm(member.environmentId as EnvironmentId);
  const card = cardOf(llm.status?.provider ?? "uno");
  const computer = member.computerLabel || "this computer";
  if (props.changing) {
    return (
      <AssistantAiChoice
        environmentId={member.environmentId}
        computer={computer}
        narrow
        className="p-2"
      />
    );
  }
  return (
    <div className="px-3 py-2" data-testid="assistant-profile-brain">
      <p className="text-sm">{llm.loading ? "…" : BRAIN_NAME[card]}</p>
      <p className="text-xs text-muted-foreground">{aiChoiceNote(computer)}</p>
    </div>
  );
}

// ── Where you talk ────────────────────────────────────────────────────────

export function TeamChannels(props: { readonly member: TeamMember }) {
  const { member } = props;
  // Linking happens right here (audit 27.10 #14), not on the older page.
  const [connecting, setConnecting] = useState<ConnectChannel | null>(null);
  const telegram = member.summary?.telegram;
  const slack = member.summary?.slack;
  const linkTo = (channel: ConnectChannel) => (
    <button
      type="button"
      onClick={() => setConnecting(channel)}
      className="cursor-pointer text-xs text-primary hover:underline"
    >
      Link
    </button>
  );
  return (
    <>
      <div className="flex h-9 items-center gap-2 border-b border-border/70 px-3 text-sm">
        <SendIcon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          {telegram?.configured && telegram.shared ? "Telegram · Uno's bot" : "Telegram · your bot"}
        </span>
        {telegram?.configured ? (
          <span className="text-xs text-muted-foreground">
            {telegram.botUsername ? `@${telegram.botUsername}` : "linked"}
          </span>
        ) : (
          linkTo("telegram")
        )}
      </div>
      <div className="flex h-9 items-center gap-2 border-b border-border/70 px-3 text-sm">
        <SlackIcon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">Slack</span>
        {slack?.configured ? (
          <span className="text-xs text-muted-foreground">
            {slack.botUserName ? slack.botUserName : "linked"}
          </span>
        ) : (
          linkTo("slack")
        )}
      </div>
      <div className="flex h-9 items-center gap-2 border-b border-border/70 px-3 text-sm">
        <MessageCircleIcon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1">Here in Uno Work</span>
        <span className="text-xs text-muted-foreground">always</span>
      </div>
      <p
        className="px-3 py-2 text-xs text-muted-foreground"
        data-testid="assistant-profile-uno-bot"
      >
        {member.isUno
          ? "Uno talks through our Telegram bot — Link shows its code."
          : "Its own Telegram bot (you make it in @BotFather) or Slack."}
      </p>
      <ConnectChannelDialog
        environmentId={member.environmentId as EnvironmentId}
        projectId={member.projectId as ProjectId}
        channel={connecting}
        telegramMode={member.isUno ? "shared" : "own"}
        onClose={() => setConnecting(null)}
      />
    </>
  );
}

// ── What it can use ───────────────────────────────────────────────────────

export function TeamConnectors(props: {
  readonly member: TeamMember;
  readonly place: Parameters<typeof TeammateAccess>[0]["place"];
  readonly nameOf: (projectId: string) => string;
}) {
  const { member } = props;
  const actions = useTeamActions();
  const [shown, setShown] = useState<AssistantAccess | null>(null);
  const access = shown ?? member.profile.access;
  const name = member.profile.name;

  const change = async (next: AssistantAccess) => {
    setShown(next);
    try {
      const result = await putAssistantApps({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId,
        permissions: appPermissionsOf(next.connectors),
      });
      await actions.refresh();
      const losses = daemonLossLine(result.losses ?? [], props.nameOf);
      toastManager.add({
        type: "success",
        title: `${name}: apps changed`,
        description: losses ? `${losses}. It's in Needs you too.` : "From its next step.",
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't change its apps",
        description: errorText(cause, "Its computer didn't answer."),
      });
    } finally {
      setShown(null);
    }
  };

  if (!access) return null;
  return (
    <TeammateAccess
      name={name}
      access={access}
      onChange={member.revoked ? null : (next) => void change(next)}
      place={props.place}
      projects={member.profile.projects}
      foldWhenFull
      onlyConnectors
    />
  );
}

// ── Its routines ──────────────────────────────────────────────────────────

/**
 * Its repeating tasks — on a cloud computer the console wakes it for them.
 * A laptop sleeps and closes: there is no scheduler here (Misha 21.10).
 */
export function TeamRoutines(props: {
  readonly member: TeamMember;
  readonly machine: MachineRow | undefined;
}) {
  const { member, machine } = props;
  const navigate = useNavigate();
  // Its computer's own box id counts too (audit 27.10 #11): opened by its
  // direct address, the account's list isn't there, but the daemon knows its box.
  const ownBoxId = useOwnBoxId(member.environmentId);
  const boxId = machine?.box?.id ?? ownBoxId;
  const onCloud = boxId !== null && (machine?.kind !== "computer" || ownBoxId !== null);
  const schedules = useQuery({
    queryKey: ["uno-assistants", "schedules", boxId],
    queryFn: () => listAssistantSchedules(boxId!),
    enabled: onCloud,
    staleTime: 30_000,
    retry: false,
  });
  if (!onCloud) {
    return (
      <div
        className="flex items-start gap-2 border-t border-border/70 px-3 py-2 text-xs"
        data-testid="assistant-profile-routines-laptop"
      >
        <CloudIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-muted-foreground">
          Routines run on a cloud computer — a laptop sleeps and closes.
        </span>
        <button
          type="button"
          onClick={() => void navigate({ to: "/my-uno" })}
          className="shrink-0 cursor-pointer text-primary hover:underline"
        >
          Get one
        </button>
      </div>
    );
  }
  const root = member.summary?.workspaceRoot ?? null;
  const own = (schedules.data ?? []).filter((schedule) => {
    const where = workspaceFromCommand(schedule.command);
    // Uno's older schedules name no folder: they are its.
    return where === null ? member.isUno && schedule.prompt !== null : where === root;
  });
  if (own.length === 0) {
    return (
      <p className="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
        No routines yet — ask it for one in a chat ("every Monday at 9, sum up my week").
      </p>
    );
  }
  return (
    <>
      {own.map((task) => (
        <div
          key={task.id}
          className="flex h-8 items-center gap-2 border-t border-border/70 px-3 text-sm"
          data-testid="assistant-profile-routine"
        >
          <CalendarClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{task.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{describeCron(task.cron)}</span>
        </div>
      ))}
    </>
  );
}
