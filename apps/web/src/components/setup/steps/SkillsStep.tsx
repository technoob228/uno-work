/**
 * Step 4 — skills. What the agents already read comes first ("Found in your
 * project", "On this computer"); then two cards picked for the kind of work,
 * the rest of the catalog under "More skills", each installed by the daemon
 * for every agent (see setupSkills.ts); then "Add your own skill" — a link,
 * a file or the laptop's skills folder, previewed before anything is written
 * (skillImport.ts). The one-click store is a teaser.
 */
import type { FoundSkill, SkillsStageResult } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenIcon,
  BugIcon,
  CheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FeatherIcon,
  ListChecksIcon,
  Loader2Icon,
  MessageSquareIcon,
  PaletteIcon,
  PlusIcon,
  PresentationIcon,
  ShieldCheckIcon,
  StoreIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useHomeFolderPath } from "../../../hooks/useFolderChats";
import { useServerProviders } from "../../../rpc/serverState";
import { cn } from "../../../lib/utils";
import { openInstallDocs } from "../../onboarding/harnessInstallLinks";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { SetupHeading, SetupShell } from "../SetupShell";
import { SkillImportDialog } from "../SkillImportDialog";
import { SkillsAddOwn } from "../SkillsAddOwn";
import { foundRowKey, SkillsFound } from "../SkillsFound";
import {
  existingNames,
  type FoundPlugin,
  foundSkillsView,
  installedAgents,
  readFoundSkills,
  setFoundSkillEnabled,
  setPluginEnabled,
  stageFolder,
} from "../skillImport";
import {
  ALL_SETUP_SKILLS,
  installSkill,
  moreSkills,
  offeredSkills,
  readSkillsStatus,
  removeSkill,
  type SetupSkill,
  type SetupSkillIcon,
} from "../setupSkills";
import { useSetupNavigation } from "../useSetupNavigation";
import { useSetupProgress } from "../useSetupProgress";

const ICON: Readonly<Record<SetupSkillIcon, typeof BookOpenIcon>> = {
  book: BookOpenIcon,
  palette: PaletteIcon,
  slides: PresentationIcon,
  feather: FeatherIcon,
  shield: ShieldCheckIcon,
  check: ListChecksIcon,
  bug: BugIcon,
};

export const SKILLS_STATUS_QUERY_KEY = ["uno-setup", "skills"] as const;
const FOUND_SKILLS_QUERY_KEY = ["uno-setup", "skills", "found"] as const;
const CATALOG_IDS: ReadonlySet<string> = new Set(ALL_SETUP_SKILLS.map((skill) => skill.id));

function useFoundSkills(projectPath: string | null) {
  const environmentId = usePrimaryEnvironmentId();
  return useQuery({
    queryKey: [...FOUND_SKILLS_QUERY_KEY, environmentId, projectPath],
    queryFn: () => readFoundSkills(environmentId!, projectPath),
    enabled: environmentId !== null,
    // An older daemon has no scan: the step just shows what it showed before.
    retry: false,
  });
}

export function useSkillsStatus() {
  const environmentId = usePrimaryEnvironmentId();
  return useQuery({
    queryKey: [...SKILLS_STATUS_QUERY_KEY, environmentId],
    queryFn: () => readSkillsStatus(environmentId!),
    enabled: environmentId !== null,
    retry: false,
  });
}

function SkillRow({
  skill,
  first,
  compact = false,
}: {
  skill: SetupSkill;
  first: boolean;
  compact?: boolean;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const status = useSkillsStatus();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = ICON[skill.icon];
  const added = status.data?.installed.has(skill.id) === true;
  const available = status.data ? status.data.available.has(skill.id) : true;

  const toggle = async () => {
    if (!environmentId) return;
    setPending(true);
    setError(null);
    try {
      if (added) await removeSkill(environmentId, skill.id);
      else await installSkill(environmentId, skill.id);
      await queryClient.invalidateQueries({ queryKey: SKILLS_STATUS_QUERY_KEY });
      if (!added) toastManager.add({ type: "success", title: `${skill.name} added` });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change the skill.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className={cn(
        "flex items-start gap-4 px-4 sm:px-5",
        compact ? "py-3" : "py-4",
        !first && "border-t border-border",
        added && "bg-primary/[0.03]",
      )}
      data-testid={`setup-skill-${skill.id}`}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-xl border border-border bg-background",
          compact ? "size-8" : "size-10",
        )}
      >
        <Icon className={cn("text-muted-foreground", compact ? "size-4" : "size-5")} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 font-medium">
          {skill.name}
          <span className="text-xs font-normal text-muted-foreground">from {skill.by}</span>
        </div>
        <div className="mt-0.5 text-sm text-muted-foreground">{skill.description}</div>
        {compact ? null : (
          <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
            <MessageSquareIcon className="mt-0.5 size-3 shrink-0" />
            <span>{skill.example}</span>
          </div>
        )}
        {error ? <div className="mt-2 text-xs text-destructive-foreground">{error}</div> : null}
      </div>
      <Button
        size="sm"
        variant="outline"
        className={cn(
          added &&
            "border-success/40 bg-success/[0.06] text-success-foreground hover:bg-success/10",
        )}
        onClick={() => void toggle()}
        disabled={pending || status.isPending || !available}
        title={available ? undefined : "Update Uno Work on this computer to add it"}
      >
        {pending ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : added ? (
          <CheckIcon className="size-3.5" />
        ) : (
          <PlusIcon className="size-3.5" />
        )}
        {added ? "Added" : "Add"}
      </Button>
    </div>
  );
}

export function SkillsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const progress = useSetupProgress();
  const status = useSkillsStatus();
  const project = progress.project;
  const found = useFoundSkills(project?.path ?? null);
  const [preview, setPreview] = useState<SkillsStageResult | null>(null);
  const [pendingRow, setPendingRow] = useState<string | null>(null);
  const providers = useServerProviders();
  const installed = useMemo(() => installedAgents(providers), [providers]);
  const home = useHomeFolderPath(environmentId);
  const [previewPlace, setPreviewPlace] = useState<"computer" | "project">("computer");
  const kind = project?.kind;
  const offered = offeredSkills(kind);
  const more = moreSkills(kind);
  const view = useMemo(() => foundSkillsView(found.data ?? [], CATALOG_IDS), [found.data]);
  const existing = useMemo(
    () => existingNames(found.data ?? [], status.data?.installed ?? new Set()),
    [found.data, status.data],
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: SKILLS_STATUS_QUERY_KEY });
  // A project's own skills/ folder: no agent reads it, so turning one on goes
  // through the same preview as any other skill.
  const turnOn = async (skill: FoundSkill) => {
    const folder = skill.paths[0];
    if (!environmentId || !folder) return;
    setPendingRow(foundRowKey(skill));
    try {
      const staged = await stageFolder(environmentId, folder);
      setPreviewPlace("project");
      setPreview(staged);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: cause instanceof Error ? cause.message : "Couldn't read this skill.",
      });
    } finally {
      setPendingRow(null);
    }
  };
  // Untick = the folders move to <skills folder>-off (files kept); tick = back.
  const runToggle = async (key: string, change: () => Promise<void>, done: string) => {
    setPendingRow(key);
    try {
      await change();
      await refresh();
      toastManager.add({ type: "success", title: done, description: "Applies to new chats." });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: cause instanceof Error ? cause.message : "Couldn't change the skill.",
      });
    } finally {
      setPendingRow(null);
    }
  };
  const toggleSkill = (skill: FoundSkill, enabled: boolean) => {
    if (!environmentId) return;
    void runToggle(
      foundRowKey(skill),
      () =>
        setFoundSkillEnabled({ environmentId, skill, enabled, projectPath: project?.path ?? null }),
      enabled ? `${skill.name} is on` : `${skill.name} is off. Its files are kept`,
    );
  };
  const togglePlugin = (plugin: FoundPlugin, enabled: boolean) => {
    if (!environmentId) return;
    void runToggle(
      `plugin:${plugin.pluginId}`,
      () => setPluginEnabled({ environmentId, pluginId: plugin.pluginId, enabled }),
      enabled ? `Plugin ${plugin.name} is on` : `Plugin ${plugin.name} is off in Claude Code`,
    );
  };
  return (
    <>
      <SkillsFound
        project={view.project}
        computer={view.computer}
        plugins={view.plugins}
        projectName={project?.name || null}
        actions={{
          installed,
          home,
          projectPath: project?.path ?? null,
          pending: pendingRow,
          onToggle: toggleSkill,
          onTogglePlugin: togglePlugin,
          onTurnOn: (skill) => void turnOn(skill),
        }}
      />
      <div className="overflow-hidden rounded-2xl border border-border">
        {offered.map((skill, index) => (
          <SkillRow key={skill.id} skill={skill} first={index === 0} />
        ))}
      </div>
      <Collapsible className="mt-3 overflow-hidden rounded-2xl border border-border">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium sm:px-5">
          More skills
          <span className="text-xs font-normal text-muted-foreground">{more.length}</span>
          <ChevronRightIcon className="ml-auto size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          {more.map((skill) => (
            <SkillRow key={skill.id} skill={skill} first={false} compact />
          ))}
        </CollapsiblePanel>
      </Collapsible>
      <SkillsAddOwn
        environmentId={environmentId}
        onStaged={(staged) => {
          setPreviewPlace("computer");
          setPreview(staged);
        }}
      />
      <SkillImportDialog
        environmentId={environmentId}
        preview={preview}
        project={project ? { name: project.name || "this project", path: project.path } : null}
        existing={existing}
        initialPlace={previewPlace}
        onClose={() => setPreview(null)}
        onAdded={(added) => {
          setPreview(null);
          toastManager.add({
            type: "success",
            title: added === 1 ? "Skill added" : `${added} skills added`,
            description: `Your AI uses ${added === 1 ? "it" : "them"} in new chats.`,
          });
          void refresh();
        }}
      />
      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div className="text-sm">
          <h3 className="font-medium">Find more</h3>
          <p className="mt-1 text-muted-foreground">
            Skills are plain folders. Paste a link from these sites above, or ask your AI to install
            one.
          </p>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            {["https://skills.sh", "https://github.com/anthropics/skills"].map((href) => (
              <button
                key={href}
                type="button"
                onClick={() => openInstallDocs(href)}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLinkIcon className="size-3" />
                {href.replace("https://", "")}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Or say in chat: “Install the PDF skill from skills.sh”
          </p>
        </div>
        <div className="text-sm">
          <h3 className="font-medium">Write your own</h3>
          <p className="mt-1 text-muted-foreground">
            Write a skill for something you do often, like your weekly report. Ask: “Turn this into
            a skill”.
          </p>
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
            <StoreIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <b className="font-medium text-foreground">Uno Skill Store</b> · one-click skills,
              checked by us
            </span>
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
              Coming soon
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/** Skills installed for every agent plus the ones they already read — the number on Continue. */
function useSkillsCount(): number {
  const project = useSetupProgress().project;
  const status = useSkillsStatus();
  const found = useFoundSkills(project?.path ?? null);
  const view = useMemo(() => foundSkillsView(found.data ?? [], CATALOG_IDS), [found.data]);
  return (status.data?.installed.size ?? 0) + view.activeNames.size;
}

export function SkillsStep() {
  const { completeStep } = useSetupNavigation();
  const count = useSkillsCount();
  return (
    <SetupShell
      step="skills"
      primary={{
        label: count > 0 ? `Continue with ${count} skill${count > 1 ? "s" : ""}` : "Continue",
        onClick: () => void completeStep("skills"),
      }}
    >
      <SetupHeading
        title="Give your AI skills"
        lead="A skill is a short playbook for one kind of task. Add it once, and your AI uses it when it fits."
      />
      <SkillsPanel />
    </SetupShell>
  );
}
