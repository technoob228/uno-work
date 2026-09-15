/**
 * "Continue on <machine>…" — carries the current chat (files, history, and
 * `.env` only when ticked) to another connected machine and opens it there in
 * a new worktree. The files travel through this client, never through GitHub.
 *
 * The dialog only wires environment APIs and the store into
 * `runContinueOnMachine`; the step order, retry checkpointing and target
 * project resolution live in `continueOnMachine.ts`.
 */
import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ProjectId,
  ScopedThreadRef,
  ThreadContinueInspectResult,
  ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  CircleIcon,
  RefreshCwIcon,
  ServerIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CONTINUE_ON_MACHINE_STEPS,
  canStartContinue,
  ContinueOnMachineFailure,
  ContinueUpdateRequiredError,
  describeContinueTarget,
  findMachineNeedingUpdate,
  inspectContinueTarget,
  resolveContinueTargetProject,
  runContinueOnMachine,
  waitUntil,
  type ContinueOnMachineDeps,
  type ContinueOnMachineProgress,
  type ContinueOnMachineStep,
  type ContinueTargetProject,
} from "../continueOnMachine";
import { CONTINUE_ON_MACHINE_COPY, STEP_LABEL_WITH_MACHINE } from "../continueOnMachineCopy";
import { createEnvironmentApi, ensureEnvironmentApi } from "../environmentApi";
import {
  readPrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentDescriptor,
} from "../environments/primary";
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
  /** Known to run a version without the direct protocol (unknown until connected). */
  readonly needsUpdate: boolean;
  /** A project with the same remote is registered there. */
  readonly hasProject: boolean;
}

interface RunState {
  readonly step: ContinueOnMachineStep | null;
  readonly failedStep: ContinueOnMachineStep | null;
  readonly error: string | null;
  readonly progress: ContinueOnMachineProgress;
}

const IDLE_RUN: RunState = { step: null, failedStep: null, error: null, progress: {} };

/** The descriptor a machine advertised: the primary one from bootstrap, others from their runtime. */
function readDescriptor(
  environmentId: EnvironmentId,
): ExecutionEnvironmentDescriptor | null | undefined {
  const primary = readPrimaryEnvironmentDescriptor();
  if (primary?.environmentId === environmentId) return primary;
  return useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.descriptor;
}

/** The read-only look at the target project, keyed by the machine it was taken on. */
type InspectionState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly environmentId: EnvironmentId }
  | {
      readonly status: "done";
      readonly environmentId: EnvironmentId;
      readonly target: ContinueTargetProject;
      readonly result: ThreadContinueInspectResult;
    }
  | { readonly status: "error"; readonly environmentId: EnvironmentId; readonly error: string };

const IDLE_INSPECTION: InspectionState = { status: "idle" };

function describeError(caught: unknown): string {
  if (caught instanceof Error && caught.message.trim().length > 0) return caught.message;
  if (typeof caught === "object" && caught !== null && "message" in caught) {
    const message = (caught as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return "Something went wrong.";
}

export function ContinueOnMachineDialog({
  threadRef,
  open,
  onOpenChange,
}: ContinueOnMachineDialogProps) {
  const navigate = useNavigate();
  const savedRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedRuntime = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  // The sidebar summary is enough (title + project) and is loaded for every
  // thread, unlike the full detail which only the open chat has.
  const thread = useStore((state) => selectSidebarThreadSummaryByRef(state, threadRef));
  const project = useStore((state) =>
    thread
      ? selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))
      : undefined,
  );

  const [targetEnvironmentId, setTargetEnvironmentId] = useState<EnvironmentId | null>(null);
  const [copyEnv, setCopyEnv] = useState(false);
  const [archiveSource, setArchiveSource] = useState(false);
  const [inspection, setInspection] = useState<InspectionState>(IDLE_INSPECTION);
  const [inspectionAttempt, setInspectionAttempt] = useState(0);
  const [run, setRun] = useState<RunState>(IDLE_RUN);
  const [pending, setPending] = useState(false);
  const [sendProgress, setSendProgress] = useState<{ sent: number; total: number } | null>(null);

  /** Where the chat lands on `targetId`: a project there with the same remote, else a fresh clone. */
  const resolveTargetProjectFor = useCallback(
    (targetId: EnvironmentId): ContinueTargetProject | null => {
      if (!project) return null;
      const targetBaseDirectory =
        savedRuntime[targetId]?.serverConfig?.settings?.addProjectBaseDirectory?.trim() ||
        "~/projects";
      return resolveContinueTargetProject({
        sourceProject: project,
        targetEnvironmentId: targetId,
        projects: selectProjectsAcrossEnvironments(useStore.getState()),
        targetBaseDirectory,
      });
    },
    [project, savedRuntime],
  );

  const targets = useMemo<ReadonlyArray<TargetOption>>(() => {
    return (
      Object.values(savedRegistry)
        .filter((record) => record.environmentId !== threadRef?.environmentId)
        .map((record) => {
          const runtime = savedRuntime[record.environmentId];
          const connected = runtime?.connectionState === "connected";
          // A connected machine has told us its version; a disconnected one is
          // checked again once the run connects to it.
          const needsUpdate =
            connected &&
            runtime?.descriptor != null &&
            runtime.descriptor.capabilities.threadContinueDirect !== true;
          const hasProject = resolveTargetProjectFor(record.environmentId)?.kind === "existing";
          const status = connected
            ? CONTINUE_ON_MACHINE_COPY.connected
            : (runtime?.connectionState ?? "disconnected");
          return {
            environmentId: record.environmentId,
            label: runtime?.descriptor?.label ?? record.label,
            connected,
            needsUpdate,
            hasProject,
            detail: needsUpdate
              ? CONTINUE_ON_MACHINE_COPY.needsUpdate
              : `${hasProject ? CONTINUE_ON_MACHINE_COPY.hasProject : CONTINUE_ON_MACHINE_COPY.willAddProject} · ${status}`,
          };
        })
        // Machines that already have the project first.
        .toSorted(
          (left, right) =>
            Number(right.hasProject) - Number(left.hasProject) ||
            left.label.localeCompare(right.label),
        )
    );
  }, [resolveTargetProjectFor, savedRegistry, savedRuntime, threadRef?.environmentId]);

  const selectedTarget = targets.find((target) => target.environmentId === targetEnvironmentId);

  const sourceLabel = useMemo(() => {
    if (!threadRef) return "this machine";
    if (primaryDescriptor?.environmentId === threadRef.environmentId) {
      return primaryDescriptor.label;
    }
    const runtime = savedRuntime[threadRef.environmentId];
    return (
      runtime?.descriptor?.label ?? savedRegistry[threadRef.environmentId]?.label ?? "this machine"
    );
  }, [primaryDescriptor, savedRegistry, savedRuntime, threadRef]);

  // Known blockers before the run: the chat's own machine (always connected)
  // and a connected target that advertised an older version.
  const machineNeedingUpdate = useMemo(() => {
    if (!threadRef) return null;
    const sourceDescriptor =
      primaryDescriptor?.environmentId === threadRef.environmentId
        ? primaryDescriptor
        : savedRuntime[threadRef.environmentId]?.descriptor;
    const sourceBlocked = findMachineNeedingUpdate([
      { label: sourceLabel, descriptor: sourceDescriptor },
    ]);
    if (sourceBlocked) return sourceBlocked;
    return selectedTarget?.needsUpdate ? selectedTarget.label : null;
  }, [primaryDescriptor, savedRuntime, selectedTarget, sourceLabel, threadRef]);

  const reset = useCallback(() => {
    setTargetEnvironmentId(null);
    setCopyEnv(false);
    setArchiveSource(false);
    setSendProgress(null);
    setInspection(IDLE_INSPECTION);
    setRun(IDLE_RUN);
    setPending(false);
  }, []);

  const ensureTargetConnected = useCallback(
    async (targetId: EnvironmentId) => {
      await ensureEnvironmentConnectionBootstrapped(targetId);
      if (savedRuntime[targetId]?.connectionState !== "connected") {
        await reconnectSavedEnvironment(targetId).catch(() => undefined);
      }
      // Throws with a useful message when the connection never came up.
      createEnvironmentApi(requireEnvironmentConnection(targetId).client);
    },
    [savedRuntime],
  );

  // Look at the target project as soon as a machine is picked, so the person
  // knows before pressing the button whether the project is there already.
  useEffect(() => {
    if (!open || targetEnvironmentId === null) return;
    const targetId = targetEnvironmentId;
    const target = resolveTargetProjectFor(targetId);
    if (!target) return;
    let cancelled = false;
    setInspection({ status: "loading", environmentId: targetId });
    void inspectContinueTarget(
      {
        ensureTargetConnected: () => ensureTargetConnected(targetId),
        inspect: (input) => ensureEnvironmentApi(targetId).threadContinue.inspect(input),
      },
      target,
    ).then(
      (result) => {
        if (cancelled) return;
        setInspection({ status: "done", environmentId: targetId, target, result });
      },
      (caught: unknown) => {
        if (cancelled) return;
        setInspection({ status: "error", environmentId: targetId, error: describeError(caught) });
      },
    );
    return () => {
      cancelled = true;
    };
    // `resolveTargetProjectFor`/`ensureTargetConnected` change with the store; re-inspecting
    // on every store tick would flicker, so only a new pick or an explicit retry re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetEnvironmentId, inspectionAttempt]);

  const targetState =
    inspection.status === "done" && inspection.environmentId === targetEnvironmentId
      ? describeContinueTarget(inspection.result, inspection.target)
      : null;

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
      // The run uses the project the inspection looked at, so what the dialog
      // said is about the same folder that gets used.
      const targetProject =
        inspection.status === "done" && inspection.environmentId === targetId
          ? inspection.target
          : resolveTargetProjectFor(targetId);
      if (!targetProject) return;
      setPending(true);
      setSendProgress(null);
      setRun({ step: null, failedStep: null, error: null, progress });

      const deps: ContinueOnMachineDeps = {
        ensureTargetConnected: () => ensureTargetConnected(targetId),
        assertMachinesSupported: () => {
          const blocked = findMachineNeedingUpdate([
            { label: sourceLabel, descriptor: readDescriptor(threadRef.environmentId) },
            { label: target.label, descriptor: readDescriptor(targetId) },
          ]);
          if (blocked !== null) throw new ContinueUpdateRequiredError(blocked);
        },
        inspect: (input) => ensureEnvironmentApi(targetId).threadContinue.inspect(input),
        snapshot: (input) =>
          ensureEnvironmentApi(threadRef.environmentId).threadContinue.snapshot(input),
        readChunk: (input) =>
          ensureEnvironmentApi(threadRef.environmentId).threadContinue.readChunk(input),
        writeChunk: (input) => ensureEnvironmentApi(targetId).threadContinue.writeChunk(input),
        land: (input) => ensureEnvironmentApi(targetId).threadContinue.land(input),
        discardSource: (input) =>
          ensureEnvironmentApi(threadRef.environmentId).threadContinue.discard(input),
        complete: (input) =>
          ensureEnvironmentApi(threadRef.environmentId).threadContinue.complete(input),
        openThread: (input) => openThreadOnTarget(targetId, input),
        onStep: (step) =>
          setRun((current) => ({ ...current, step, failedStep: null, error: null })),
        onSendProgress: (sent, total) => setSendProgress({ sent, total }),
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
          description: CONTINUE_ON_MACHINE_COPY.successDescription(result.landed),
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
      ensureTargetConnected,
      handleOpenChange,
      inspection,
      openThreadOnTarget,
      pending,
      project,
      resolveTargetProjectFor,
      sourceLabel,
      targets,
      thread,
      threadRef,
    ],
  );

  const inspectionForTarget =
    inspection.status !== "idle" && inspection.environmentId === targetEnvironmentId
      ? inspection
      : null;
  const canSubmit =
    !pending &&
    targetEnvironmentId !== null &&
    !!thread &&
    !!project &&
    canStartContinue({ targetState, machineNeedingUpdate });

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
                                target.needsUpdate
                                  ? "text-destructive"
                                  : target.connected
                                    ? "text-emerald-600"
                                    : "text-muted-foreground",
                              )}
                            >
                              {target.detail}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {machineNeedingUpdate !== null ? (
                    <p
                      className="flex items-start gap-2 text-destructive text-xs"
                      data-testid="continue-update-required"
                    >
                      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                      <span>{CONTINUE_ON_MACHINE_COPY.updateRequired(machineNeedingUpdate)}</span>
                    </p>
                  ) : selectedTarget && inspectionForTarget ? (
                    <TargetProjectNotice
                      machineLabel={selectedTarget.label}
                      inspection={inspectionForTarget}
                      targetState={targetState}
                      disabled={pending}
                      onRetry={() => setInspectionAttempt((attempt) => attempt + 1)}
                    />
                  ) : null}
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="continue-copy-env"
                      className="mt-0.5"
                      checked={copyEnv}
                      disabled={pending}
                      onCheckedChange={(checked) => setCopyEnv(checked === true)}
                    />
                    <div className="flex flex-col gap-0.5">
                      <Label htmlFor="continue-copy-env" className="text-sm text-foreground">
                        {CONTINUE_ON_MACHINE_COPY.copyEnv}
                      </Label>
                      <span className="text-muted-foreground text-xs">
                        {CONTINUE_ON_MACHINE_COPY.copyEnvHint}
                      </span>
                    </div>
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
                          {step === "sending" && (active || failed) && sendProgress ? (
                            <span className="text-muted-foreground">
                              {CONTINUE_ON_MACHINE_COPY.sendingProgress(
                                sendProgress.sent,
                                sendProgress.total,
                              )}
                            </span>
                          ) : null}
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
                disabled={!canSubmit}
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

/**
 * Where the chat lands on the chosen machine: the project is there (the chat
 * gets its own worktree beside it), will be added, or the folder is unusable.
 */
function TargetProjectNotice(props: {
  readonly machineLabel: string;
  readonly inspection: Exclude<InspectionState, { status: "idle" }>;
  readonly targetState: ReturnType<typeof describeContinueTarget> | null;
  readonly disabled: boolean;
  readonly onRetry: () => void;
}) {
  const { inspection, machineLabel, targetState } = props;
  if (inspection.status === "loading") {
    return (
      <p className="flex items-center gap-2 text-muted-foreground text-xs">
        <RefreshCwIcon className="size-3 shrink-0 animate-spin" />
        {CONTINUE_ON_MACHINE_COPY.inspecting(machineLabel)}
      </p>
    );
  }
  if (inspection.status === "error" || targetState === null) {
    return (
      <p className="flex items-center gap-2 text-destructive text-xs">
        <span className="min-w-0">
          {CONTINUE_ON_MACHINE_COPY.inspectFailed(machineLabel)}
          {inspection.status === "error" ? `: ${inspection.error}` : null}
        </span>
        <button
          type="button"
          className="shrink-0 underline underline-offset-2"
          disabled={props.disabled}
          onClick={props.onRetry}
        >
          {CONTINUE_ON_MACHINE_COPY.inspectRetry}
        </button>
      </p>
    );
  }
  const text = CONTINUE_ON_MACHINE_COPY.targetState(targetState, machineLabel);
  return (
    <p
      className={cn(
        "text-xs",
        targetState.kind === "not-git" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {text}
    </p>
  );
}
