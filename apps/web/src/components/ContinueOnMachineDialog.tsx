/**
 * "Continue on <machine>…" — carries the current chat (files, history,
 * optionally `.env`) to another connected machine and opens it there.
 *
 * The dialog only wires environment APIs and the store into
 * `runContinueOnMachine`; the step order, retry checkpointing and target
 * project resolution live in `continueOnMachine.ts`.
 */
import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  CircleIcon,
  RefreshCwIcon,
  ServerIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  CONTINUE_ON_MACHINE_STEPS,
  ContinueOnMachineFailure,
  resolveContinueTargetProject,
  runContinueOnMachine,
  waitUntil,
  type ContinueOnMachineDeps,
  type ContinueOnMachineProgress,
  type ContinueOnMachineStep,
} from "../continueOnMachine";
import { CONTINUE_ON_MACHINE_COPY, STEP_LABEL_WITH_MACHINE } from "../continueOnMachineCopy";
import { createEnvironmentApi, ensureEnvironmentApi } from "../environmentApi";
import {
  ensureEnvironmentConnectionBootstrapped,
  reconnectSavedEnvironment,
  requireEnvironmentConnection,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { cn } from "../lib/utils";
import {
  selectProjectByRef,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadSummaryByRef,
  selectThreadExistsByRef,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogBackdrop, DialogPortal, DialogViewport } from "./ui/dialog";
import { Label } from "./ui/label";
import { ScrollArea } from "./ui/scroll-area";
import { stackedThreadToast, toastManager } from "./ui/toast";

const OPEN_THREAD_TIMEOUT_MS = 8_000;

export interface ContinueOnMachineDialogProps {
  readonly threadRef: ScopedThreadRef | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

interface TargetOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly detail: string;
}

interface RunState {
  readonly step: ContinueOnMachineStep | null;
  readonly failedStep: ContinueOnMachineStep | null;
  readonly error: string | null;
  readonly progress: ContinueOnMachineProgress;
}

const IDLE_RUN: RunState = { step: null, failedStep: null, error: null, progress: {} };

export function ContinueOnMachineDialog({
  threadRef,
  open,
  onOpenChange,
}: ContinueOnMachineDialogProps) {
  const navigate = useNavigate();
  const savedRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedRuntime = useSavedEnvironmentRuntimeStore((state) => state.byId);
  // The sidebar summary is enough (title + project) and is loaded for every
  // thread, unlike the full detail which only the open chat has.
  const thread = useStore((state) => selectSidebarThreadSummaryByRef(state, threadRef));
  const project = useStore((state) =>
    thread
      ? selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))
      : undefined,
  );

  const [targetEnvironmentId, setTargetEnvironmentId] = useState<EnvironmentId | null>(null);
  const [copyEnv, setCopyEnv] = useState(true);
  const [archiveSource, setArchiveSource] = useState(false);
  const [run, setRun] = useState<RunState>(IDLE_RUN);
  const [pending, setPending] = useState(false);

  const targets = useMemo<ReadonlyArray<TargetOption>>(() => {
    return Object.values(savedRegistry)
      .filter((record) => record.environmentId !== threadRef?.environmentId)
      .toSorted((left, right) => left.label.localeCompare(right.label))
      .map((record) => {
        const runtime = savedRuntime[record.environmentId];
        const connected = runtime?.connectionState === "connected";
        return {
          environmentId: record.environmentId,
          label: runtime?.descriptor?.label ?? record.label,
          connected,
          detail: connected
            ? CONTINUE_ON_MACHINE_COPY.connected
            : (runtime?.connectionState ?? "disconnected"),
        };
      });
  }, [savedRegistry, savedRuntime, threadRef?.environmentId]);

  const selectedTarget = targets.find((target) => target.environmentId === targetEnvironmentId);

  const reset = useCallback(() => {
    setTargetEnvironmentId(null);
    setCopyEnv(true);
    setArchiveSource(false);
    setRun(IDLE_RUN);
    setPending(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const openThreadOnTarget = useCallback(
    async (targetId: EnvironmentId, input: { threadId: ThreadId; projectId: ProjectId }) => {
      const store = useStore.getState();
      store.setActiveEnvironmentId(targetId);
      const ref = { environmentId: targetId, threadId: input.threadId };
      const appeared = await waitUntil(() => selectThreadExistsByRef(useStore.getState(), ref), {
        timeoutMs: OPEN_THREAD_TIMEOUT_MS,
      });
      if (!appeared) {
        throw new Error(CONTINUE_ON_MACHINE_COPY.openingThreadTimedOut);
      }
      await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    },
    [navigate],
  );

  const runContinue = useCallback(
    async (targetId: EnvironmentId, progress: ContinueOnMachineProgress) => {
      if (!thread || !project || !threadRef || pending) return;
      const target = targets.find((candidate) => candidate.environmentId === targetId);
      if (!target) return;
      setPending(true);
      setRun({ step: null, failedStep: null, error: null, progress });

      const targetBaseDirectory =
        savedRuntime[targetId]?.serverConfig?.settings?.addProjectBaseDirectory?.trim() ||
        "~/projects";
      const targetProject = resolveContinueTargetProject({
        sourceProject: project,
        targetEnvironmentId: targetId,
        projects: selectProjectsAcrossEnvironments(useStore.getState()),
        targetBaseDirectory,
      });

      const deps: ContinueOnMachineDeps = {
        ensureTargetConnected: async () => {
          await ensureEnvironmentConnectionBootstrapped(targetId);
          if (savedRuntime[targetId]?.connectionState !== "connected") {
            await reconnectSavedEnvironment(targetId).catch(() => undefined);
          }
          // Throws with a useful message when the connection never came up.
          createEnvironmentApi(requireEnvironmentConnection(targetId).client);
        },
        prepare: (input) =>
          ensureEnvironmentApi(threadRef.environmentId).threadContinue.prepare(input),
        receive: (input) => ensureEnvironmentApi(targetId).threadContinue.receive(input),
        complete: (input) =>
          ensureEnvironmentApi(threadRef.environmentId).threadContinue.complete(input),
        openThread: (input) => openThreadOnTarget(targetId, input),
        onStep: (step) =>
          setRun((current) => ({ ...current, step, failedStep: null, error: null })),
      };

      try {
        const result = await runContinueOnMachine(
          deps,
          {
            sourceThreadId: threadRef.threadId,
            targetMachineLabel: target.label,
            targetProject,
            copyEnv,
            archiveSource,
          },
          progress,
        );
        handleOpenChange(false);
        toastManager.add({
          type: "success",
          title: CONTINUE_ON_MACHINE_COPY.successTitle(target.label),
          description: CONTINUE_ON_MACHINE_COPY.successDescription(result.received),
        });
      } catch (caught) {
        const failure =
          caught instanceof ContinueOnMachineFailure
            ? caught
            : new ContinueOnMachineFailure("connecting", progress, caught);
        setRun({
          step: null,
          failedStep: failure.step,
          error: failure.message,
          progress: failure.progress,
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: CONTINUE_ON_MACHINE_COPY.failureTitle,
            description: `${CONTINUE_ON_MACHINE_COPY.stepFailed(failure.step)}: ${failure.message}`,
          }),
        );
      } finally {
        setPending(false);
      }
    },
    [
      archiveSource,
      copyEnv,
      handleOpenChange,
      openThreadOnTarget,
      pending,
      project,
      savedRuntime,
      targets,
      thread,
      threadRef,
    ],
  );

  const showSteps = run.step !== null || run.failedStep !== null;
  const stepIndex = (step: ContinueOnMachineStep) => CONTINUE_ON_MACHINE_STEPS.indexOf(step);
  const activeIndex =
    run.step !== null
      ? stepIndex(run.step)
      : run.failedStep !== null
        ? stepIndex(run.failedStep)
        : -1;

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
                {CONTINUE_ON_MACHINE_COPY.title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-muted-foreground text-sm">
                {thread ? CONTINUE_ON_MACHINE_COPY.description(thread.title) : "Pick a chat first."}
              </DialogPrimitive.Description>
            </div>

            {run.error ? (
              <div className="border-b border-destructive/30 bg-destructive/8 px-6 py-3 text-destructive text-xs">
                {run.failedStep ? `${CONTINUE_ON_MACHINE_COPY.stepFailed(run.failedStep)}: ` : null}
                {run.error}
              </div>
            ) : null}

            <ScrollArea className="max-h-96">
              <div className="flex flex-col gap-4 px-6 py-4">
                <div className="flex flex-col gap-2">
                  <span className="text-muted-foreground text-xs">
                    {CONTINUE_ON_MACHINE_COPY.targetLabel}
                  </span>
                  {targets.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      {CONTINUE_ON_MACHINE_COPY.noTargets}
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
                              setTargetEnvironmentId(target.environmentId);
                              setRun(IDLE_RUN);
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
                            <span
                              className={cn(
                                "shrink-0 text-[11px]",
                                target.connected ? "text-emerald-600" : "text-muted-foreground",
                              )}
                            >
                              {target.detail}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="continue-copy-env"
                      checked={copyEnv}
                      disabled={pending}
                      onCheckedChange={(checked) => setCopyEnv(checked === true)}
                    />
                    <Label htmlFor="continue-copy-env" className="text-sm text-foreground">
                      {CONTINUE_ON_MACHINE_COPY.copyEnv}
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="continue-archive-source"
                      checked={archiveSource}
                      disabled={pending}
                      onCheckedChange={(checked) => setArchiveSource(checked === true)}
                    />
                    <Label htmlFor="continue-archive-source" className="text-sm text-foreground">
                      {CONTINUE_ON_MACHINE_COPY.archiveSource}
                    </Label>
                  </div>
                </div>

                {showSteps ? (
                  <ol className="flex flex-col gap-1 rounded-lg bg-muted/50 px-3 py-2 text-xs">
                    {CONTINUE_ON_MACHINE_STEPS.map((step, index) => {
                      const done = index < activeIndex;
                      const active = index === activeIndex && run.step !== null;
                      const failed = run.failedStep === step;
                      return (
                        <li
                          key={step}
                          className={cn(
                            "flex items-center gap-2",
                            failed
                              ? "text-destructive"
                              : done || active
                                ? "text-foreground"
                                : "text-muted-foreground",
                          )}
                        >
                          {failed ? (
                            <XIcon className="size-3 shrink-0" />
                          ) : done ? (
                            <CheckIcon className="size-3 shrink-0" />
                          ) : active ? (
                            <RefreshCwIcon className="size-3 shrink-0 animate-spin" />
                          ) : (
                            <CircleIcon className="size-3 shrink-0 opacity-40" />
                          )}
                          {STEP_LABEL_WITH_MACHINE(step, selectedTarget?.label ?? "the machine")}
                        </li>
                      );
                    })}
                  </ol>
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
                {CONTINUE_ON_MACHINE_COPY.cancel}
              </Button>
              <Button
                size="sm"
                disabled={pending || targetEnvironmentId === null || !thread || !project}
                onClick={() => {
                  if (targetEnvironmentId) void runContinue(targetEnvironmentId, run.progress);
                }}
              >
                {pending ? (
                  <RefreshCwIcon className="size-3.5 animate-spin" />
                ) : (
                  <ArrowRightIcon className="size-3.5" />
                )}
                {pending
                  ? CONTINUE_ON_MACHINE_COPY.submitting
                  : run.failedStep !== null
                    ? CONTINUE_ON_MACHINE_COPY.retry
                    : CONTINUE_ON_MACHINE_COPY.submit}
              </Button>
            </div>
          </DialogPrimitive.Popup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
