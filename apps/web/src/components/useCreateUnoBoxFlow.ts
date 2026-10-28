/**
 * The "create a computer, then connect it" flow behind every Create button
 * (`CreateUnoBoxSection`, the assistant wizard's "Create its computer").
 *
 * Creating is billable, so one click = one job: the mutation is keyed per
 * environment (two mounted copies can't both fire) and `submit` refuses while
 * one runs. Once the box exists, "slow" is never "failed": the flow keeps the
 * box as "still starting", retries on its own every 15 s for up to 10 minutes
 * and offers `retryNow`. Unmounting stops the retries (the box stays on the
 * account's list).
 */
import type { EnvironmentId, UnoBoxCreateJobStatus } from "@t3tools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { unoCloudCreateBoxMutationOptions, workspaceQueryKeys } from "../lib/workspaceReactQuery";
import type { CreateUnoBoxInput, CreateUnoBoxResult, UnoBoxCreateStage } from "../unoBoxCreation";
import {
  UnoBoxConnectAbortedError,
  connectUnoBoxById,
  isUnoBoxStillStartingError,
} from "../unoBoxConnect";

/** Between automatic retries of a "still starting" box. */
const STILL_STARTING_RETRY_MS = 15_000;
/** Each automatic retry gets this long (wake + connect) before the next pause. */
const STILL_STARTING_ATTEMPT_BUDGET_MS = 45_000;
/** Stop retrying on our own after this long; the button keeps working. */
const STILL_STARTING_GIVE_UP_MS = 10 * 60_000;

export interface UnoBoxStillStarting {
  readonly boxId: number;
  readonly name: string;
  readonly since: number;
  readonly lastError: unknown;
}

export type CreateUnoBoxRequest = Omit<CreateUnoBoxInput, "onStatus" | "onStage" | "signal">;

export function useCreateUnoBoxFlow(
  /** Environment holding the Uno account (normally the primary one). */
  environmentId: EnvironmentId | null,
  onCreated: (result: CreateUnoBoxResult) => void | Promise<void>,
) {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<UnoBoxCreateStage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [stillStarting, setStillStarting] = useState<UnoBoxStillStarting | null>(null);
  const [retrying, setRetrying] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const boxListedRef = useRef(false);

  // Closing the surface stops background retries (the box stays on the list).
  useEffect(() => () => abortRef.current?.abort(), []);

  const createBox = useMutation(unoCloudCreateBoxMutationOptions(environmentId, queryClient));
  const creating = createBox.isPending;
  const isPending = creating || retrying;

  const refreshBoxList = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.unoCloud(environmentId) });
  }, [environmentId, queryClient]);

  const handleStatus = useCallback(
    (status: UnoBoxCreateJobStatus) => {
      // The moment the box exists it is billed — make it visible in the lists.
      if (status.boxId != null && !boxListedRef.current) {
        boxListedRef.current = true;
        refreshBoxList();
      }
    },
    [refreshBoxList],
  );

  const retryStillStarting = useCallback(
    async (target: UnoBoxStillStarting) => {
      if (environmentId === null) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setRetrying(true);
      setStage("connecting");
      try {
        const record = await connectUnoBoxById(environmentId, target.boxId, target.name, {
          budgetMs: STILL_STARTING_ATTEMPT_BUDGET_MS,
          signal: controller.signal,
          onProgress: (progress) =>
            setStage(
              progress.phase === "waking"
                ? "starting"
                : progress.phase === "retrying"
                  ? "retrying"
                  : "connecting",
            ),
        });
        setStillStarting(null);
        refreshBoxList();
        await onCreated({
          status: { jobId: "retry", state: "ready", boxId: target.boxId },
          record,
        });
      } catch (caught) {
        if (caught instanceof UnoBoxConnectAbortedError) return;
        if (isUnoBoxStillStartingError(caught)) {
          setStillStarting({ ...target, lastError: caught.lastError });
        } else {
          setStillStarting(null);
          setError(caught);
        }
      } finally {
        if (abortRef.current === controller) {
          setRetrying(false);
          setStage(null);
        }
      }
    },
    [environmentId, onCreated, refreshBoxList],
  );

  // Keep trying on our own while the box is "still starting".
  useEffect(() => {
    if (!stillStarting || retrying) return;
    if (Date.now() - stillStarting.since > STILL_STARTING_GIVE_UP_MS) return;
    const timer = setTimeout(() => void retryStillStarting(stillStarting), STILL_STARTING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [retrying, retryStillStarting, stillStarting]);

  const submit = useCallback(
    async (request: CreateUnoBoxRequest) => {
      if (isPending || stillStarting !== null || environmentId === null) return;
      setError(null);
      setStage("creating");
      boxListedRef.current = false;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await createBox.mutateAsync({
          ...request,
          onStatus: handleStatus,
          onStage: setStage,
          signal: controller.signal,
        });
        await onCreated(result);
      } catch (caught) {
        if (caught instanceof UnoBoxConnectAbortedError) return;
        if (isUnoBoxStillStartingError(caught)) {
          refreshBoxList();
          setStillStarting({
            boxId: caught.boxId,
            name: request.name,
            since: Date.now(),
            lastError: caught.lastError,
          });
        } else {
          setError(caught);
        }
      } finally {
        setStage(null);
      }
    },
    [createBox, environmentId, handleStatus, isPending, onCreated, refreshBoxList, stillStarting],
  );

  const retryNow = useCallback(() => {
    if (stillStarting) void retryStillStarting(stillStarting);
  }, [retryStillStarting, stillStarting]);

  return {
    /** The step to show, while creating or retrying; null otherwise. */
    stage: stage !== null && isPending ? stage : null,
    error,
    clearError: () => setError(null),
    stillStarting,
    creating,
    retrying,
    isPending,
    submit,
    retryNow,
  };
}
