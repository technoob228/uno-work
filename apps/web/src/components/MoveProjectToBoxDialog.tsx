/**
 * "Move to a box…" — moves the current project onto an Uno box in one dialog:
 * pick a connected box (or create one), then clone + carry `.env` + register
 * the project there, and open it.
 *
 * Git is the transport, so only git-backed projects can be moved as-is;
 * everything else is offered an empty project on the box instead.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ArrowRightIcon, RefreshCwIcon, ServerIcon } from "lucide-react";

import { createEnvironmentApi, ensureEnvironmentApi } from "../environmentApi";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  ensureEnvironmentConnectionBootstrapped,
  reconnectSavedEnvironment,
  requireEnvironmentConnection,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { cn, newCommandId, newProjectId } from "../lib/utils";
import {
  describeMoveProjectResult,
  moveProjectToBox,
  type MoveProjectToBoxDeps,
  type MoveProjectToBoxMode,
  type MoveProjectToBoxStep,
} from "../moveProjectToBox";
import { useSettings } from "../hooks/useSettings";
import type { Project } from "../types";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { CreateUnoBoxSection } from "./CreateUnoBoxSection";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogBackdrop, DialogPortal, DialogViewport } from "./ui/dialog";
import { Label } from "./ui/label";
import { ScrollArea } from "./ui/scroll-area";
import { stackedThreadToast, toastManager } from "./ui/toast";

const STEP_LABELS: Record<MoveProjectToBoxStep, string> = {
  connecting: "Connecting to the computer…",
  cloning: "Cloning the repository…",
  "copying-env": "Copying .env…",
  "creating-project": "Creating the project…",
};

export interface MoveProjectToBoxDialogProps {
  readonly project: Project | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

interface TargetOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly detail: string;
}

export function MoveProjectToBoxDialog({
  project,
  open,
  onOpenChange,
}: MoveProjectToBoxDialogProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedRuntime = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const settings = useSettings((current) => current);
  const { handleNewThread } = useHandleNewThread();

  const [targetEnvironmentId, setTargetEnvironmentId] = useState<EnvironmentId | null>(null);
  const [creatingBox, setCreatingBox] = useState(false);
  const [copyEnv, setCopyEnv] = useState(true);
  const [step, setStep] = useState<MoveProjectToBoxStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const remoteUrl = project?.repositoryIdentity?.locator.remoteUrl ?? null;
  const mode: MoveProjectToBoxMode = remoteUrl ? "clone" : "empty";

  const targets = useMemo<ReadonlyArray<TargetOption>>(() => {
    return Object.values(savedRegistry)
      .filter((record) => record.environmentId !== project?.environmentId)
      .toSorted((left, right) => left.label.localeCompare(right.label))
      .map((record) => {
        const runtime = savedRuntime[record.environmentId];
        const connected = runtime?.connectionState === "connected";
        return {
          environmentId: record.environmentId,
          label: runtime?.descriptor?.label ?? record.label,
          connected,
          detail: connected ? "Connected" : (runtime?.connectionState ?? "disconnected"),
        };
      });
  }, [project?.environmentId, savedRegistry, savedRuntime]);

  const reset = useCallback(() => {
    setTargetEnvironmentId(null);
    setCreatingBox(false);
    setCopyEnv(true);
    setStep(null);
    setError(null);
    setPending(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const runMove = useCallback(
    async (targetId: EnvironmentId) => {
      if (!project || pending) return;
      setPending(true);
      setError(null);
      const projectId = newProjectId();
      const targetBaseDirectory =
        savedRuntime[targetId]?.serverConfig?.settings?.addProjectBaseDirectory?.trim() ||
        "~/projects";

      const deps: MoveProjectToBoxDeps = {
        ensureTargetConnected: async () => {
          await ensureEnvironmentConnectionBootstrapped(targetId);
          if (savedRuntime[targetId]?.connectionState !== "connected") {
            await reconnectSavedEnvironment(targetId).catch(() => undefined);
          }
          // Throws with a useful message when the connection never came up.
          createEnvironmentApi(requireEnvironmentConnection(targetId).client);
        },
        cloneRepository: (input) =>
          ensureEnvironmentApi(targetId).sourceControl.cloneRepository(input),
        readSourceFile: async (absolutePath) => {
          try {
            const file = await ensureEnvironmentApi(project.environmentId).filesystem.readFile({
              path: absolutePath,
            });
            return { content: file.content, encoding: file.encoding };
          } catch {
            // A missing `.env` is the common case, not an error worth failing on.
            return null;
          }
        },
        writeTargetFile: (input) => ensureEnvironmentApi(targetId).projects.writeFile(input),
        createProject: async ({ cwd, title }) => {
          await ensureEnvironmentApi(targetId).orchestration.dispatchCommand({
            type: "project.create",
            commandId: newCommandId(),
            projectId,
            title,
            workspaceRoot: cwd,
            createWorkspaceRootIfMissing: true,
            ...(project.defaultModelSelection
              ? { defaultModelSelection: project.defaultModelSelection }
              : {}),
            createdAt: new Date().toISOString(),
          });
        },
        onStep: setStep,
      };

      try {
        const result = await moveProjectToBox(deps, {
          mode,
          projectName: project.name,
          sourceCwd: project.cwd,
          remoteUrl,
          targetBaseDirectory,
          copyEnv,
        });
        handleOpenChange(false);
        toastManager.add({
          type: "success",
          title: `"${result.title}" is on the computer`,
          description: describeMoveProjectResult(result),
        });
        // Opening a thread in the new project also switches the active
        // environment, so the app lands on the box.
        await handleNewThread(scopeProjectRef(targetId, projectId), {
          envMode: settings.defaultThreadEnvMode,
        }).catch(() => undefined);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Could not move the project.";
        setError(message);
        toastManager.add(
          stackedThreadToast({ type: "error", title: "Move failed", description: message }),
        );
      } finally {
        setPending(false);
        setStep(null);
      }
    },
    [
      copyEnv,
      handleNewThread,
      handleOpenChange,
      mode,
      pending,
      project,
      remoteUrl,
      savedRuntime,
      settings.defaultThreadEnvMode,
    ],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport>
          <DialogPrimitive.Popup
            data-slot="dialog-popup"
            className="relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 max-w-lg flex-col rounded-2xl border bg-popover text-popover-foreground shadow-lg/5"
          >
            <div className="flex flex-col gap-1 border-b border-border p-6">
              <DialogPrimitive.Title className="font-heading font-semibold text-lg leading-none">
                Move to a computer
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-muted-foreground text-sm">
                {project
                  ? mode === "clone"
                    ? `"${project.name}" will be cloned from its git remote onto the computer you pick.`
                    : `"${project.name}" has no git remote, so only an empty project can be created on the computer.`
                  : "Pick a project first."}
              </DialogPrimitive.Description>
            </div>

            {error ? (
              <div className="border-b border-destructive/30 bg-destructive/8 px-6 py-3 text-destructive text-xs">
                {error}
              </div>
            ) : null}

            <ScrollArea className="max-h-80">
              <div className="flex flex-col gap-4 px-6 py-4">
                <div className="flex flex-col gap-2">
                  <span className="text-muted-foreground text-xs">Target computer</span>
                  {targets.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      No other environments yet — create a computer below.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {targets.map((target) => {
                        const selected = targetEnvironmentId === target.environmentId;
                        return (
                          <button
                            key={target.environmentId}
                            type="button"
                            disabled={pending}
                            aria-pressed={selected}
                            onClick={() => {
                              setCreatingBox(false);
                              setTargetEnvironmentId(target.environmentId);
                            }}
                            className={cn(
                              "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60",
                              selected
                                ? "border-primary bg-primary/5"
                                : "border-border hover:bg-muted/50",
                            )}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate text-sm text-foreground">
                                {target.label}
                              </span>
                            </span>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {target.detail}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Checkbox
                    id="move-copy-env"
                    checked={copyEnv}
                    disabled={pending}
                    onCheckedChange={(checked) => setCopyEnv(checked === true)}
                  />
                  <Label htmlFor="move-copy-env" className="text-sm text-foreground">
                    Copy .env secrets
                  </Label>
                </div>

                {creatingBox ? (
                  <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-medium text-foreground text-sm">Create a new computer</h3>
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={pending}
                        onClick={() => setCreatingBox(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                    <CreateUnoBoxSection
                      environmentId={primaryEnvironmentId}
                      defaultName={project?.name ?? ""}
                      submitLabel="Create computer and move"
                      disabled={pending}
                      onCreated={async ({ record }) => {
                        setCreatingBox(false);
                        setTargetEnvironmentId(record.environmentId);
                        await runMove(record.environmentId);
                      }}
                    />
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      setTargetEnvironmentId(null);
                      setCreatingBox(true);
                    }}
                  >
                    <ServerIcon className="size-3.5" />
                    Create a new computer
                  </Button>
                )}

                {step ? (
                  <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-muted-foreground text-xs">
                    <RefreshCwIcon className="size-3 shrink-0 animate-spin" />
                    {STEP_LABELS[step]}
                  </div>
                ) : null}
              </div>
            </ScrollArea>

            <div className="flex justify-between gap-2 border-t border-border bg-muted/40 px-6 py-4">
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => handleOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={pending || creatingBox || targetEnvironmentId === null || !project}
                onClick={() => {
                  if (targetEnvironmentId) void runMove(targetEnvironmentId);
                }}
              >
                {pending ? (
                  <RefreshCwIcon className="size-3.5 animate-spin" />
                ) : (
                  <ArrowRightIcon className="size-3.5" />
                )}
                {pending
                  ? "Moving…"
                  : mode === "clone"
                    ? "Clone onto the computer"
                    : "Create empty project there"}
              </Button>
            </div>
          </DialogPrimitive.Popup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
