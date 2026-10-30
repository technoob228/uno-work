/**
 * Dev mode's Projects page: per project, what new chats start with and the
 * actions (commands) with their automatic triggers.
 *
 * Defaults follow the scope sentence, so a project on two computers can be set
 * on both at once. Actions are saved on the project on one computer; the chat
 * header's actions menu edits the same list.
 *
 * @module components/settings/ProjectsSettings
 */
import { type EnvironmentId, type ProjectScript } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { newCommandId } from "~/lib/utils";
import { nextProjectScriptId, replaceProjectScript } from "~/projectScripts";
import type { Project } from "~/types";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  NewChatAccessRow,
  NewChatModelRow,
  NewChatWorkspaceRow,
  PerComputerNote,
} from "./NewChatDefaultsRows";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsScopeProvider, useSettingsScope } from "./SettingsScopeContext";
import { projectsForComputer, type SettingsScopeSearch } from "./settingsScope";

async function saveProject(project: Project, patch: { scripts: ProjectScript[] }) {
  const api = readEnvironmentApi(project.environmentId);
  if (!api) return;
  try {
    await api.orchestration.dispatchCommand({
      type: "project.meta.update",
      commandId: newCommandId(),
      projectId: project.id,
      ...patch,
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not save",
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

interface ActionDraft {
  readonly id: string | null;
  readonly name: string;
  readonly command: string;
  readonly runOnWorktreeCreate: boolean;
  readonly runOnSettle: boolean;
}

const EMPTY_ACTION: ActionDraft = {
  id: null,
  name: "",
  command: "",
  runOnWorktreeCreate: false,
  runOnSettle: false,
};

function ActionDialog(props: {
  readonly project: Project;
  readonly draft: ActionDraft;
  readonly onClose: () => void;
}) {
  const { project, onClose } = props;
  const [draft, setDraft] = useState(props.draft);
  const existing = project.scripts.find((script) => script.id === draft.id);
  const ready = draft.name.trim().length > 0 && draft.command.trim().length > 0;

  const save = () => {
    const script: ProjectScript = {
      id:
        existing?.id ??
        nextProjectScriptId(
          draft.name,
          project.scripts.map((item) => item.id),
        ),
      icon: existing?.icon ?? "play",
      name: draft.name.trim(),
      command: draft.command.trim(),
      runOnWorktreeCreate: draft.runOnWorktreeCreate,
      runOnSettle: draft.runOnSettle,
    };
    void saveProject(project, { scripts: replaceProjectScript(project.scripts, script) });
    onClose();
  };
  const remove = () => {
    void saveProject(project, {
      scripts: project.scripts.filter((script) => script.id !== draft.id),
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{existing ? "Edit action" : "Add action"}</DialogTitle>
          <DialogDescription>Actions run in the chat's folder.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="project-action-name">Name</Label>
            <Input
              id="project-action-name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Test"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-action-command">Command</Label>
            <Textarea
              id="project-action-command"
              value={draft.command}
              onChange={(event) => setDraft({ ...draft, command: event.target.value })}
              placeholder="bun test"
            />
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Run when a copy (worktree) is created</span>
            <Switch
              checked={draft.runOnWorktreeCreate}
              onCheckedChange={(checked) =>
                setDraft({ ...draft, runOnWorktreeCreate: Boolean(checked) })
              }
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Run when the chat moves to Done</span>
            <Switch
              checked={draft.runOnSettle}
              onCheckedChange={(checked) => setDraft({ ...draft, runOnSettle: Boolean(checked) })}
            />
          </label>
        </DialogPanel>
        <DialogFooter>
          {existing ? (
            <Button variant="destructive-outline" className="mr-auto" onClick={remove}>
              Delete
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ProjectActions(props: { readonly project: Project }) {
  const { project } = props;
  const [draft, setDraft] = useState<ActionDraft | null>(null);
  return (
    <SettingsRow
      title="Actions"
      description={
        project.scripts.length === 0 ? "Commands you run from the chat header." : "Click to edit."
      }
      control={
        <Button size="xs" variant="outline" onClick={() => setDraft(EMPTY_ACTION)}>
          <PlusIcon className="size-3" />
          Add action
        </Button>
      }
    >
      {/* No empty body: the row keeps its bottom padding. */}
      {project.scripts.length > 0 || draft ? (
        <>
          {project.scripts.length > 0 ? (
            <div className="mt-2 flex flex-col pb-3">
              {project.scripts.map((script) => (
                <button
                  key={script.id}
                  type="button"
                  className="-mx-2 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
                  onClick={() =>
                    setDraft({
                      id: script.id,
                      name: script.name,
                      command: script.command,
                      runOnWorktreeCreate: script.runOnWorktreeCreate,
                      runOnSettle: script.runOnSettle === true,
                    })
                  }
                >
                  <span className="shrink-0 font-medium">{script.name}</span>
                  <code className="min-w-0 truncate font-mono text-muted-foreground">
                    {script.command}
                  </code>
                  {script.runOnWorktreeCreate ? (
                    <Badge variant="outline" className="ml-auto shrink-0">
                      On copy
                    </Badge>
                  ) : null}
                  {script.runOnSettle ? (
                    <Badge
                      variant="outline"
                      className={script.runOnWorktreeCreate ? "shrink-0" : "ml-auto shrink-0"}
                    >
                      On Done
                    </Badge>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {draft ? (
            <ActionDialog project={project} draft={draft} onClose={() => setDraft(null)} />
          ) : null}
        </>
      ) : null}
    </SettingsRow>
  );
}

/** One project's rows, scoped to it: the same rows the sentence drives elsewhere. */
function ProjectSection(props: {
  readonly projectKey: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly machine: string | undefined;
  readonly actionsProject: Project | null;
  readonly onSelectScope: (next: SettingsScopeSearch) => void;
}) {
  const search: SettingsScopeSearch = {
    project: props.projectKey,
    ...(props.machine === undefined ? {} : { machine: props.machine }),
  };
  return (
    <SettingsScopeProvider search={search} onChange={props.onSelectScope}>
      <SettingsSection title={props.title}>
        <NewChatModelRow environmentId={props.environmentId} />
        <NewChatAccessRow />
        <NewChatWorkspaceRow />
        {props.actionsProject ? <ProjectActions project={props.actionsProject} /> : null}
      </SettingsSection>
    </SettingsScopeProvider>
  );
}

export function ProjectsSettingsPanel(props: { readonly environmentId: EnvironmentId }) {
  const { groups, search, scope, selectScope, singleComputer } = useSettingsScope();
  const projects = projectsForComputer(groups, search.machine).filter(
    (group) => search.project === undefined || group.projectKey === search.project,
  );
  const pickedComputer = search.machine ?? (singleComputer ? props.environmentId : null);
  return (
    <SettingsPageContainer>
      {projects.length === 0 ? (
        <SettingsSection title="Projects">
          <SettingsRow
            title="No projects"
            description={
              scope.kind === "unavailable"
                ? scope.message
                : "Projects on this computer show up here."
            }
          />
        </SettingsSection>
      ) : (
        projects.map((group) => {
          const member =
            pickedComputer === null
              ? group.memberProjects.length === 1
                ? group.memberProjects[0]
                : null
              : group.memberProjects.find((entry) => entry.environmentId === pickedComputer);
          return (
            <ProjectSection
              key={group.projectKey}
              projectKey={group.projectKey}
              title={group.displayName}
              environmentId={member?.environmentId ?? group.environmentId}
              machine={search.machine}
              actionsProject={member ?? null}
              onSelectScope={selectScope}
            />
          );
        })
      )}
      {pickedComputer === null && projects.some((group) => group.memberProjects.length > 1) ? (
        <PerComputerNote what="Actions" />
      ) : null}
    </SettingsPageContainer>
  );
}
