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
import { listConnectors } from "../../../lib/setupApi";
import { readFileText } from "../../files/filesApi";
import { cn } from "../../../lib/utils";
import { useServerProviders } from "../../../rpc/serverState";
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
import { useSetupHandoff } from "../useSetupHome";

/** The setup's own notes in materials/, not the person's material. */
const MATERIAL_NOTES = new Set(["links.md", "README.md", "UNO-SUMMARY.md"]);

/** Lines of `materials/links.md` ("- https://…"). */
export function countListedLinks(text: string): number {
  return text.split("\n").filter((line) => /^- https?:\/\//.test(line.trim())).length;
}

/** "3 files, 1 link". */
export function materialLine(files: number, links: number): string {
  const parts = [];
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (links > 0) parts.push(`${links} link${links === 1 ? "" : "s"}`);
  return parts.join(", ");
}

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
      const api = ensureEnvironmentApi(environmentId!);
      // files.list, not filesystem.browse: browse lists folders only.
      const listing = await api.files.list({ path: `${materialsRoot}/materials` });
      const names = listing.entries
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith("."));
      const links = names.includes("links.md")
        ? countListedLinks(
            await readFileText(environmentId!, `${materialsRoot}/materials/links.md`).catch(
              () => "",
            ),
          )
        : 0;
      return {
        files: names.filter((name) => !MATERIAL_NOTES.has(name)).length,
        links,
        read: names.includes("UNO-SUMMARY.md") || names.includes("README.md"),
      };
    },
    enabled: environmentId !== null && materialsRoot !== null,
    retry: false,
  });
  const connectors = useQuery({
    queryKey: ["uno-setup", "connectors", environmentId, "done"],
    queryFn: () => listConnectors({ environmentId: environmentId! }).catch(() => null),
    enabled: environmentId !== null,
    retry: false,
  });

  const channels = [
    assistant.data && telegramChannelState(assistant.data.telegram) === "on"
      ? `Telegram${assistant.data.telegram.botUsername ? ` @${assistant.data.telegram.botUsername}` : ""}`
      : null,
    assistant.data && slackChannelState(assistant.data.slack) === "on" ? "Slack" : null,
  ].filter((entry): entry is string => entry !== null);
  const answered = SETUP_QUESTIONS.filter((question) => progress.answers[question.id]).length;
  const tools = [
    ...(connectors.data?.connectors ?? [])
      .filter((connector) => connector.connected)
      .map((connector) => connector.name),
    ...settings.mcpServers.map((server) =>
      settings.mcpServers.length > 1 ? `MCP server ${server.name}` : "MCP server",
    ),
  ];

  const finish = () => update((current) => markCompleted(current, "done"));

  // A first task goes to Home's composer, typed in and pointed at the
  // project, on the AI picked in step 1 — one press of Send starts it.
  const handOff = useSetupHandoff((state) => state.handOff);
  const startTask = async (task: string) => {
    setPending(task);
    try {
      await finish();
      handOff(task, project ? { cwd: project.path, name: project.name } : null);
      goHome();
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
          value={aiId === "uno" ? `${aiName} · AI hours every month` : aiName}
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
          value={materialLine(materials.data?.files ?? 0, materials.data?.links ?? 0)}
          sub={materials.data?.read ? "Read by your AI" : "Not read yet"}
          empty={(materials.data?.files ?? 0) + (materials.data?.links ?? 0) === 0}
          skipped={skipped("materials")}
        />
      </div>
      <h3 className="mt-8 mb-3 text-sm font-medium">Start with one of these</h3>
      <div className="flex flex-col gap-2" data-testid="setup-first-tasks">
        {FIRST_TASKS[kind].map((task) => (
          <button
            key={task}
            type="button"
            disabled={pending !== null}
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
