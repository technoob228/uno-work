/**
 * Step 8 — what got set up, read back from where it really lives (the draft
 * store's default model, the project, the skill folders, the MCP list, the
 * assistant's connectors, the materials folder), with a way back into every
 * skipped step, and three first tasks that open a chat in the project with
 * the task typed in.
 */
import { ASSISTANT_PROJECT_ID, ProviderInstanceId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon, MessageSquareIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { telegramChannelState, slackChannelState } from "../../../assistant/assistantChat.logic";
import { useComposerDraftStore } from "../../../composerDraftStore";
import { ensureEnvironmentApi } from "../../../environmentApi";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useHomeFolderPath } from "../../../hooks/useFolderChats";
import { useSettings } from "../../../hooks/useSettings";
import { getAssistant } from "../../../lib/managerApi";
import { cn } from "../../../lib/utils";
import { useServerProviders } from "../../../rpc/serverState";
import { useHomeLaunchers } from "../../computer/useHomeLaunchers";
import { getDriverOption } from "../../settings/providerDriverMeta";
import { Button } from "../../ui/button";
import { OwnToolsRow } from "../OwnToolsDialog";
import {
  FIRST_TASKS,
  SETUP_QUESTIONS,
  markCompleted,
  parseWorkKind,
  tildePath,
  type SetupStepId,
} from "../setupModel";
import { ALL_SETUP_SKILLS } from "../setupSkills";
import { useSkillsStatus } from "./SkillsStep";
import { SetupHeading, SetupShell } from "../SetupShell";
import { useSetupNavigation } from "../useSetupNavigation";
import { useSetupProgress, useUpdateSetupProgress } from "../useSetupProgress";

function SummaryRow({
  step,
  label,
  value,
  sub,
  empty,
  skipped,
  first,
}: {
  step: SetupStepId;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  empty: boolean;
  skipped: boolean;
  first: boolean;
}) {
  const { goToStep } = useSetupNavigation();
  const missing = skipped || empty;
  return (
    <div
      className={cn(
        "grid grid-cols-[20px_1fr_auto] items-center gap-x-3 gap-y-0.5 px-4 py-3 sm:grid-cols-[20px_140px_1fr_auto] sm:px-5",
        !first && "border-t border-border",
      )}
      data-testid={`setup-summary-${step}`}
    >
      {missing ? (
        <span className="size-[18px] rounded-full border border-dashed border-border" aria-hidden />
      ) : (
        <span className="flex size-[18px] items-center justify-center rounded-full bg-primary text-primary-foreground">
          <CheckIcon className="size-3" strokeWidth={3} />
        </span>
      )}
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="col-start-2 row-start-2 min-w-0 text-sm sm:col-start-3 sm:row-start-1">
        {missing ? (
          <span className="text-muted-foreground">{skipped ? "Skipped" : "None yet"}</span>
        ) : (
          <>
            <span className="block truncate">{value}</span>
            {sub ? (
              <span className="block truncate text-xs text-muted-foreground">{sub}</span>
            ) : null}
          </>
        )}
      </span>
      <Button
        size="xs"
        variant={missing ? "outline" : "ghost"}
        className="col-start-3 row-span-2 sm:col-start-4 sm:row-span-1"
        onClick={() => goToStep(step)}
      >
        {missing ? "Set up" : "Change"}
      </Button>
    </div>
  );
}

export function DoneStep() {
  const environmentId = usePrimaryEnvironmentId();
  const home = useHomeFolderPath(environmentId);
  const progress = useSetupProgress();
  const update = useUpdateSetupProgress();
  const settings = useSettings();
  const providers = useServerProviders();
  const { goHome } = useSetupNavigation();
  const launchers = useHomeLaunchers(environmentId);
  const stickyActive = useComposerDraftStore((store) => store.stickyActiveProvider);
  const [pending, setPending] = useState<string | null>(null);
  const project = progress.project;
  const kind = parseWorkKind(project?.kind);
  const skipped = (step: SetupStepId) => progress.skipped.includes(step);

  const aiId = stickyActive ?? ProviderInstanceId.make("uno");
  const aiProvider = providers.find((provider) => provider.instanceId === aiId);
  const aiName =
    aiId === "uno" ? "Uno AI" : (getDriverOption(aiProvider?.driver)?.label ?? String(aiId));

  const skillsStatus = useSkillsStatus();
  const skillNames = ALL_SETUP_SKILLS.filter((skill) =>
    skillsStatus.data?.installed.has(skill.id),
  ).map((skill) => skill.name);
  const assistant = useQuery({
    queryKey: ["uno-setup", "done-assistant", environmentId],
    queryFn: () => getAssistant({ environmentId: environmentId!, projectId: ASSISTANT_PROJECT_ID }),
    enabled: environmentId !== null,
    retry: false,
  });
  const materialsRoot = project?.path ?? home;
  const materials = useQuery({
    queryKey: ["uno-setup", "done-materials", environmentId, materialsRoot],
    queryFn: async () => {
      const listing = await ensureEnvironmentApi(environmentId!).filesystem.browse({
        partialPath: `${materialsRoot}/materials/`,
      });
      return listing.entries.length;
    },
    enabled: environmentId !== null && materialsRoot !== null,
    retry: false,
  });

  const channels = [
    assistant.data && telegramChannelState(assistant.data.telegram) === "on"
      ? `Telegram${assistant.data.telegram.botUsername ? ` @${assistant.data.telegram.botUsername}` : ""}`
      : null,
    assistant.data && slackChannelState(assistant.data.slack) === "on" ? "Slack" : null,
  ].filter((entry): entry is string => entry !== null);
  const answered = SETUP_QUESTIONS.filter((question) => progress.answers[question.id]).length;
  const tools = settings.mcpServers.map((server) => server.name);
  const folder = project?.path ?? home;

  const finish = () => update((current) => markCompleted(current, "done"));

  const startTask = async (task: string) => {
    if (!folder) return;
    setPending(task);
    try {
      await finish();
      await launchers.askInFolder(task, folder);
    } finally {
      setPending(null);
    }
  };

  return (
    <SetupShell
      step="done"
      primary={{
        label: "Go to Home",
        onClick: () => {
          void finish().then(goHome);
        },
      }}
    >
      <SetupHeading
        title="Your computer is set up"
        lead="Your own computer in the cloud, always online. It knows who you are, what you’re working on and where your stuff is. Give it a first task."
      />
      <div className="overflow-hidden rounded-2xl border border-border">
        <SummaryRow
          first
          step="ai"
          label="AI"
          value={aiName}
          sub="Default for new chats"
          empty={false}
          skipped={skipped("ai")}
        />
        <SummaryRow
          first={false}
          step="project"
          label="Project"
          value={project?.name}
          sub={project ? <span className="font-mono">{tildePath(project.path, home)}</span> : null}
          empty={!project}
          skipped={skipped("project")}
        />
        <SummaryRow
          first={false}
          step="instructions"
          label="Instructions"
          value="AGENTS.md"
          sub={`${answered} of ${SETUP_QUESTIONS.length} answers`}
          empty={answered === 0}
          skipped={skipped("instructions")}
        />
        <SummaryRow
          first={false}
          step="skills"
          label="Skills"
          value={skillNames.join(", ")}
          empty={skillNames.length === 0}
          skipped={skipped("skills")}
        />
        <SummaryRow
          first={false}
          step="connectors"
          label="Connectors"
          value={tools.join(", ")}
          empty={tools.length === 0}
          skipped={skipped("connectors")}
        />
        <SummaryRow
          first={false}
          step="channels"
          label="Channel"
          value={channels.join(", ")}
          sub="Message your computer from here"
          empty={channels.length === 0}
          skipped={skipped("channels")}
        />
        <SummaryRow
          first={false}
          step="materials"
          label="Material"
          value={`${materials.data ?? 0} in materials/`}
          sub="Your AI reads them when a task needs them"
          empty={(materials.data ?? 0) === 0}
          skipped={skipped("materials")}
        />
      </div>
      <h3 className="mt-8 mb-3 text-sm font-medium">Start with one of these</h3>
      <div className="flex flex-col gap-2" data-testid="setup-first-tasks">
        {FIRST_TASKS[kind].map((task) => (
          <button
            key={task}
            type="button"
            disabled={pending !== null || !folder}
            onClick={() => void startTask(task)}
            className="group flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-left text-sm transition-colors hover:border-primary/50 hover:bg-primary/[0.03] disabled:opacity-60"
          >
            <MessageSquareIcon className="size-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">{task}</span>
            <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>
      <OwnToolsRow title="Prefer your own tools?" />
    </SetupShell>
  );
}
