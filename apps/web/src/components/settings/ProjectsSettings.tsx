/**
 * Dev mode's Projects page: per project, the model new chats start with and
 * the actions (commands) with their automatic triggers.
 *
 * Saved on the project itself, so it follows the project across its chats. The
 * chat header's actions menu edits the same list.
 *
 * @module components/settings/ProjectsSettings
 */
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectScript,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "~/environmentApi";
import {
  useEnvironmentProviders,
  useEnvironmentSettings,
} from "~/environments/settings/serverSettings";
import { useSettings } from "~/hooks/useSettings";
import { newCommandId } from "~/lib/utils";
import { getCustomModelOptionsByInstance, resolveAppModelSelectionState } from "~/modelSelection";
import { nextProjectScriptId, replaceProjectScript } from "~/projectScripts";
import { deriveProviderInstanceEntries, sortProviderInstanceEntries } from "~/providerInstances";
import { selectProjectsForEnvironment, useStore } from "~/store";
import type { Project } from "~/types";

import { ProviderModelPicker } from "../chat/ProviderModelPicker";
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
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

async function saveProject(
  project: Project,
  patch: { scripts: ProjectScript[] } | { defaultModelSelection: ModelSelection | null },
) {
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

function ProjectModelRow(props: { readonly project: Project }) {
  const { project } = props;
  const providers = useEnvironmentProviders(project.environmentId);
  const clientSettings = useSettings();
  const serverSettings = useEnvironmentSettings(project.environmentId) ?? DEFAULT_UNIFIED_SETTINGS;
  const merged = useMemo(
    () => ({
      ...clientSettings,
      ...serverSettings,
      textGenerationModelSelection:
        project.defaultModelSelection ?? serverSettings.textGenerationModelSelection,
    }),
    [clientSettings, serverSettings, project.defaultModelSelection],
  );
  const selection = resolveAppModelSelectionState(merged, providers);
  const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
  const options = getCustomModelOptionsByInstance(
    merged,
    providers,
    selection.instanceId,
    selection.model,
  );
  return (
    <SettingsRow
      title="Model for new chats"
      description={
        project.defaultModelSelection
          ? "New chats in this project start with this model."
          : "Not set: new chats start with your last model."
      }
      resetAction={
        project.defaultModelSelection ? (
          <SettingResetButton
            label="project model"
            onClick={() => void saveProject(project, { defaultModelSelection: null })}
          />
        ) : null
      }
      control={
        <ProviderModelPicker
          activeInstanceId={selection.instanceId}
          model={selection.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={options}
          triggerVariant="outline"
          triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
          onInstanceModelChange={(instanceId, model) =>
            void saveProject(project, {
              defaultModelSelection: createModelSelection(instanceId, model),
            })
          }
        />
      }
    />
  );
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
    </SettingsRow>
  );
}

export function ProjectsSettingsPanel(props: { readonly environmentId: EnvironmentId }) {
  const projects = useStore(
    useShallow((state) => selectProjectsForEnvironment(state, props.environmentId)),
  );
  return (
    <SettingsPageContainer>
      {projects.length === 0 ? (
        <SettingsSection title="Projects">
          <SettingsRow title="No projects" description="Projects on this computer show up here." />
        </SettingsSection>
      ) : (
        projects.map((project) => (
          <SettingsSection key={project.id} title={project.name}>
            <ProjectModelRow project={project} />
            <ProjectActions project={project} />
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
