/**
 * "Create a new box" — shared by the add-environment modal and the
 * "Move to a box…" dialog.
 *
 * Sizes follow the plan (`newComputerSizes.ts`): 2 / 4 / 8 GB, the ones over
 * the plan's limit or what is left of it disabled with the reason and
 * "Change plan".
 *
 * Creating a box is billable, so the submit path is guarded twice: the button
 * is disabled while the mutation is pending, and the mutation itself is keyed
 * per environment so two mounted copies of this component cannot both fire.
 *
 * What a person sees: three steps (Creating your computer… → Starting… →
 * Connecting…). Once the box exists it is never reported as "failed" just
 * because it is slow: the section switches to "Still starting — we'll keep
 * trying", retries on its own, and offers "Try again now". The box is already
 * on the account list (and billed) at that point, and the list is refreshed as
 * soon as the box appears so it shows up in My machines right away.
 */
import type { EnvironmentId, UnoBoxCreateJobStatus } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, RefreshCwIcon, ServerIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { consoleLinks } from "../account/accountOverview";
import { formatRam } from "../account/billingModel";
import { cn } from "../lib/utils";
import { openInNewTab } from "../navigation/useOpenApp";
import {
  defaultSizeIndex,
  planRoom,
  planRoomLine,
  sizeBlockShort,
  sizeCostLine,
  sizeOptions,
} from "../newComputerSizes";
import { subscriptionQuery } from "./myuno/myUnoQueries";
import { unoCloudCreateBoxMutationOptions, workspaceQueryKeys } from "../lib/workspaceReactQuery";
import { describeMachineError } from "../machineErrors";
import {
  UNO_BOX_CREATE_STAGES,
  UNO_BOX_NAME_MAX_LENGTH,
  normalizeUnoBoxName,
  type CreateUnoBoxResult,
  type UnoBoxCreateStage,
} from "../unoBoxCreation";
import {
  connectUnoBoxById,
  isUnoBoxStillStartingError,
  UnoBoxConnectAbortedError,
} from "../unoBoxConnect";
import { MachineErrorNotice } from "./machines/MachineErrorNotice";
import { MachineProgressSteps } from "./machines/MachineProgressSteps";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

/** Between automatic retries of a "still starting" box. */
const STILL_STARTING_RETRY_MS = 15_000;
/** Each automatic retry gets this long (wake + connect) before the next pause. */
const STILL_STARTING_ATTEMPT_BUDGET_MS = 45_000;
/** Stop retrying on our own after this long; the button keeps working. */
const STILL_STARTING_GIVE_UP_MS = 10 * 60_000;

interface CreateUnoBoxSectionProps {
  /** Environment holding the Uno account (normally the primary one). */
  readonly environmentId: EnvironmentId | null;
  readonly defaultName?: string;
  readonly submitLabel?: string;
  readonly onCreated: (result: CreateUnoBoxResult) => void | Promise<void>;
  /** Disables the form while an enclosing flow is busy. */
  readonly disabled?: boolean;
}

interface StillStarting {
  readonly boxId: number;
  readonly name: string;
  readonly since: number;
  readonly lastError: unknown;
}

export function CreateUnoBoxSection({
  environmentId,
  defaultName,
  submitLabel = "Create computer",
  onCreated,
  disabled = false,
}: CreateUnoBoxSectionProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(() => normalizeUnoBoxName(defaultName ?? ""));
  // The plan's room for a new computer (`GET /box-subscription`); `undefined`
  // while it loads or when this interface cannot ask the account.
  const subscription = useQuery(subscriptionQuery());
  const room = useMemo(
    () => planRoom(subscription.isSuccess ? subscription.data : undefined),
    [subscription.isSuccess, subscription.data],
  );
  const options = useMemo(() => sizeOptions(room), [room]);
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);
  const sizeIndex =
    pickedIndex !== null && !options[pickedIndex]?.block ? pickedIndex : defaultSizeIndex(options);
  const picked = sizeIndex >= 0 ? (options[sizeIndex] ?? null) : null;
  const [stage, setStage] = useState<UnoBoxCreateStage | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [stillStarting, setStillStarting] = useState<StillStarting | null>(null);
  const [retrying, setRetrying] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const boxListedRef = useRef(false);

  // Closing the dialog stops background retries (the box stays on the list).
  useEffect(() => () => abortRef.current?.abort(), []);

  const createBox = useMutation(unoCloudCreateBoxMutationOptions(environmentId, queryClient));
  const isPending = createBox.isPending || retrying;
  const normalizedName = normalizeUnoBoxName(name);
  const canSubmit =
    !disabled &&
    !isPending &&
    stillStarting === null &&
    environmentId !== null &&
    picked !== null &&
    picked.block === null &&
    normalizedName.length > 0;

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
    async (target: StillStarting) => {
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

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !picked) return;
    setError(null);
    setStage("creating");
    boxListedRef.current = false;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await createBox.mutateAsync({
        name: normalizedName,
        size: picked.shape,
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
          name: normalizedName,
          since: Date.now(),
          lastError: caught.lastError,
        });
      } else {
        setError(caught);
      }
    } finally {
      setStage(null);
    }
  }, [canSubmit, createBox, handleStatus, normalizedName, onCreated, picked, refreshBoxList]);

  const showSteps = stage !== null && (createBox.isPending || retrying);
  const stepStage = stage === "retrying" ? "connecting" : stage;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="uno-box-name" className="text-xs text-muted-foreground">
          Computer name
        </Label>
        <Input
          id="uno-box-name"
          value={name}
          maxLength={UNO_BOX_NAME_MAX_LENGTH}
          placeholder="my-app"
          disabled={disabled || isPending}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleSubmit();
          }}
        />
        {name.trim().length > 0 && normalizedName !== name.trim() ? (
          <p className="text-[11px] text-muted-foreground">
            Will be created as <span className="font-medium">{normalizedName || "—"}</span>
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Size</span>
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Size">
          {options.map((option, index) => {
            const selected = index === sizeIndex;
            const blocked = option.block !== null;
            const note = blocked
              ? sizeBlockShort(option.block!, room)
              : option.recommended
                ? "Recommended"
                : option.minimum
                  ? "Minimum"
                  : null;
            return (
              <button
                key={option.shape.ramMb}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled || isPending || blocked}
                onClick={() => setPickedIndex(index)}
                data-testid={`new-computer-size-${option.shape.ramMb}`}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed",
                  selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
                  blocked && "opacity-55 hover:bg-transparent",
                )}
              >
                <span className="block text-sm font-medium text-foreground">
                  {formatRam(option.shape.ramMb)}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  {option.shape.vcpu} {option.shape.vcpu === 1 ? "core" : "cores"} ·{" "}
                  {option.shape.diskGb} GB disk
                </span>
                {note ? (
                  <span
                    className={cn(
                      "mt-0.5 block text-[10px]",
                      option.recommended && !blocked ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {note}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        {planRoomLine(room) ? (
          <p className="text-[11px] text-muted-foreground" data-testid="new-computer-plan-room">
            {planRoomLine(room)}
          </p>
        ) : null}
      </div>

      {showSteps && stepStage ? (
        <MachineProgressSteps
          steps={UNO_BOX_CREATE_STAGES}
          current={stepStage}
          note={stage === "retrying" ? "Still starting — trying again…" : null}
        />
      ) : null}

      {stillStarting && !retrying ? (
        <MachineErrorNotice
          tone="warning"
          human={{
            title: "Still starting, we'll keep trying",
            message: `${stillStarting.name} is created and already in your list of computers. It is taking longer than usual to answer; we'll connect as soon as it does.`,
            details:
              stillStarting.lastError != null
                ? describeMachineError(stillStarting.lastError).details
                : null,
            transient: true,
          }}
          action={
            <Button
              size="xs"
              variant="outline"
              data-testid="still-starting-retry"
              onClick={() => void retryStillStarting(stillStarting)}
            >
              <RefreshCwIcon className="size-3" />
              Try again now
            </Button>
          }
        />
      ) : null}

      {error ? <MachineErrorNotice error={error} /> : null}

      <Button
        size="sm"
        disabled={!canSubmit}
        onClick={() => {
          void handleSubmit();
        }}
      >
        {isPending ? (
          <RefreshCwIcon className="size-3.5 animate-spin" />
        ) : (
          <ServerIcon className="size-3.5" />
        )}
        {createBox.isPending ? "Creating…" : retrying ? "Connecting…" : submitLabel}
      </Button>
      <p className="text-[11px] text-muted-foreground" data-testid="new-computer-cost">
        {sizeCostLine(room, picked ?? options[0] ?? null)}
        {room && (!room.hasPlan || !picked || options.some((o) => o.block)) ? (
          <>
            {" "}
            <button
              type="button"
              className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
              onClick={() => openInNewTab(consoleLinks.plans)}
            >
              {room.hasPlan ? "Change plan" : "Choose a plan"}
              <ExternalLinkIcon className="size-3" />
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
}
