/**
 * The person's own AI plan is at its limit (T3 port 30.10, `planRoom.logic.ts`).
 *
 * - `DraftPlanRoomNotice` — under a new chat's centred box: "Claude on
 *   uno-work is at its limit until 3:00 PM." with "Start on MacBook" (the
 *   computer whose own Claude has room) or "Use Uno AI · Smart". With
 *   Settings → AI → "When a plan is at its limit" = "Switch by itself" the
 *   chat moves there on its own and says "Started on MacBook — …" (upstream
 *   861a51a6c4's "Using X · Claude is out of usage", and its load balancing
 *   420fd76f60 — by plan room).
 * - `ChatPlanLimitNotice` — a chat that stopped at the limit: the same line
 *   and one click on: "Continue with <account>" (a second account on this
 *   computer, Settings → AI → "Use more than one account"; only ever by this
 *   button), "Continue on MacBook" (the chat with its history, the desktop
 *   app), or "New chat on MacBook" / "New chat with Uno AI" with the last
 *   request typed in.
 * - `PlanResumeLine` — the daemon will go on by itself after the reset
 *   (planResume/): "Resumes at 16:40 · Cancel", and what that depends on.
 */
import type { DraftId } from "../../composerDraftStore";
import type { EnvironmentId, ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import { useChatOnComputer } from "../../hooks/useFolderChats";
import { useSettings } from "../../hooks/useSettings";
import { readEnvironmentServerConfig } from "../../environments/settings/serverSettings";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import {
  chatPlanLimit,
  DRIVER_BY_PLAN_PROVIDER,
  otherAccountWithRoom,
  pickComputerForNewChat,
  planAccountName,
  planFullLine,
  planProviderForDriver,
  planResumeLine,
  planStartedOnLine,
  type OtherAccount,
  type PlanProvider,
} from "../../planRoom/planRoom.logic";
import { usePlanComputers } from "../../planRoom/usePlanComputers";
import {
  pickUsableDefaultModelSelection,
  pickUsableModelSelectionForDriver,
} from "../../providerModels";
import { useSwitcherMachines } from "../computerSwitcher/useComputerSwitcher";
import { ContinueOnMachineDialog } from "../ContinueOnMachineDialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The model to start on there: that computer's own sign-in of the same plan, its main one. */
function modelOn(environmentId: EnvironmentId, provider: PlanProvider): ModelSelection | null {
  const providers = readEnvironmentServerConfig(environmentId)?.providers ?? [];
  const driver = DRIVER_BY_PLAN_PROVIDER[provider];
  return pickUsableModelSelectionForDriver(
    providers.filter((candidate) => candidate.instanceId === driver),
    driver,
  );
}

/** Another account here, as the person knows it, and what to run on it. */
function accountTarget(
  environmentId: EnvironmentId,
  other: OtherAccount,
  currentModel: string | null,
): { readonly name: string; readonly selection: ModelSelection } | null {
  const providers = readEnvironmentServerConfig(environmentId)?.providers ?? [];
  const provider = providers.find((candidate) => candidate.instanceId === other.instanceId);
  if (!provider) return null;
  const keepsModel = provider.models.some((model) => model.slug === currentModel);
  const selection =
    keepsModel && currentModel !== null
      ? { instanceId: provider.instanceId, model: currentModel }
      : pickUsableDefaultModelSelection([provider]);
  if (!selection) return null;
  const name = other.account.instanceId
    ? (provider.displayName ?? planAccountName(other.account))
    : planAccountName(other.account);
  return { name, selection };
}

/**
 * "Started on MacBook — …" for the draft a moved chat opens as: the move
 * happens in one draft, the line is read by the next one on that computer.
 */
let startedNote: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly at: number;
  draftId: DraftId | null;
} | null = null;
const STARTED_NOTE_TTL_MS = 30_000;

/**
 * "Switch by itself" moved a new chat away from these computers lately: a
 * person who comes back to one on purpose is asked, not bounced again.
 */
const autoMovedFrom = new Map<EnvironmentId, number>();
/** The same for Home's box: its own switch doesn't stop a new chat's (and back). */
const homeAutoMovedFrom = new Map<EnvironmentId, number>();
const AUTO_MOVE_QUIET_MS = 15 * 60_000;

function readStartedNote(environmentId: EnvironmentId, draftId: DraftId): string | null {
  const note = startedNote;
  if (!note || note.environmentId !== environmentId) return null;
  if (note.draftId === null && Date.now() - note.at < STARTED_NOTE_TTL_MS) note.draftId = draftId;
  return note.draftId === draftId ? note.text : null;
}

function NoticeLine({
  text,
  children,
  testId,
}: {
  text: string;
  children?: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground"
      role="status"
      data-testid={testId}
    >
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <GaugeIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0">{text}</span>
      </span>
      {children}
    </div>
  );
}

export const DraftPlanRoomNotice = memo(function DraftPlanRoomNotice({
  environmentId,
  draftId,
  driver,
  instanceId,
  onUseModel,
  smartTarget,
}: {
  environmentId: EnvironmentId;
  draftId: DraftId;
  /** The harness the new chat would start on now (`claudeAgent`, `codex`, `uno`…). */
  driver: string | null;
  /** Its provider instance: a second account has limits of its own. */
  instanceId?: string | null;
  onUseModel: (selection: ModelSelection) => void;
  /** Uno AI · Smart on this computer, when it's ready; null otherwise. */
  smartTarget: ModelSelection | null;
}) {
  const provider = planProviderForDriver(driver);
  const { computers } = usePlanComputers({ enabled: provider !== null });
  const mode = useSettings((settings) => settings.planLimitSwitch);
  const { moveDraft } = useChatOnComputer();
  const clock = useMinuteClock();
  const now = Math.max(Date.parse(clock), Date.now());
  const [moving, setMoving] = useState(false);
  const autoMovedRef = useRef<DraftId | null>(null);

  const room = pickComputerForNewChat({
    currentEnvironmentId: environmentId,
    provider,
    instanceId,
    computers,
    now,
  });
  const alternative = room.kind === "full" ? room.alternative : null;
  const startedText = readStartedNote(environmentId, draftId);
  const otherHere =
    room.kind === "full"
      ? otherAccountWithRoom({
          accounts:
            computers.find((computer) => computer.environmentId === environmentId)?.accounts ??
            null,
          provider: room.provider,
          blocked: room.account,
          now,
        })
      : null;
  const otherTarget = otherHere ? accountTarget(environmentId, otherHere, null) : null;

  const startOn = async (auto: boolean) => {
    if (room.kind !== "full" || !alternative) return;
    const modelSelection = modelOn(alternative.environmentId, room.provider);
    setMoving(true);
    try {
      if (auto) {
        startedNote = {
          environmentId: alternative.environmentId,
          text: planStartedOnLine({
            startedOn: alternative.computerName,
            provider: room.provider,
            blockedComputerName: room.computerName,
            resetsAt: room.resetsAt,
            now,
          }),
          at: Date.now(),
          draftId: null,
        };
      }
      await moveDraft(draftId, alternative.environmentId, modelSelection ? { modelSelection } : {});
    } catch (error) {
      startedNote = null;
      toastManager.add({
        type: "error",
        title: "Couldn't start the chat on that computer",
        description: errorText(error),
      });
    } finally {
      setMoving(false);
    }
  };

  // "Switch by itself": once per draft, as soon as the numbers say so.
  const movedLately = Date.now() - (autoMovedFrom.get(environmentId) ?? 0) < AUTO_MOVE_QUIET_MS;
  const autoTarget =
    mode === "auto" && alternative && !movedLately ? alternative.environmentId : null;
  useEffect(() => {
    if (autoTarget === null || autoMovedRef.current === draftId) return;
    autoMovedRef.current = draftId;
    autoMovedFrom.set(environmentId, Date.now());
    void startOn(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per draft and target
  }, [autoTarget, draftId]);

  if (room.kind !== "full") {
    return startedText ? <NoticeLine text={startedText} testId="plan-room-started-on" /> : null;
  }
  const line = planFullLine({
    provider: room.provider,
    computerName: room.computerName,
    resetsAt: room.resetsAt,
    now,
  });
  return (
    <NoticeLine text={line} testId="plan-room-notice">
      {otherTarget ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => onUseModel(otherTarget.selection)}
          data-testid="plan-room-use-account"
        >
          Use {otherTarget.name}
        </Button>
      ) : null}
      {alternative ? (
        <Button
          size="xs"
          variant="outline"
          disabled={moving}
          onClick={() => void startOn(false)}
          data-testid="plan-room-start-on"
        >
          {moving ? "Starting…" : `Start on ${alternative.computerName}`}
        </Button>
      ) : null}
      {smartTarget ? (
        <Button
          size="xs"
          variant={alternative ? "ghost" : "outline"}
          onClick={() => onUseModel(smartTarget)}
          data-testid="plan-room-use-smart"
        >
          Use Uno AI · Smart
        </Button>
      ) : null}
    </NoticeLine>
  );
});

/**
 * The chat goes on by itself after the reset. Says what it depends on: the
 * daemon has to be running then, and it can't wake a computer that sleeps.
 */
export const PlanResumeLine = memo(function PlanResumeLine({
  environmentId,
  threadRef,
  resumeAt,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  resumeAt: string;
}) {
  const clock = useMinuteClock();
  const now = Math.max(Date.parse(clock), Date.now());
  const machines = useSwitcherMachines();
  const isCloud = machines.find((machine) => machine.id === environmentId)?.kind === "uno_box";
  const [busy, setBusy] = useState(false);
  const cancel = async () => {
    setBusy(true);
    try {
      await ensureEnvironmentApi(environmentId).unoComputer.planResumeCancel({
        threadId: threadRef.threadId,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't cancel",
        description: errorText(error),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1 px-1 pb-2" data-testid="chat-plan-resume">
      <NoticeLine
        text={planResumeLine(resumeAt, now) ?? "Resuming…"}
        testId="chat-plan-resume-line"
      >
        <span aria-hidden>·</span>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => void cancel()}
          data-testid="chat-plan-resume-cancel"
        >
          Cancel
        </Button>
      </NoticeLine>
      <p className="text-center text-[11px] text-muted-foreground/80">
        {isCloud
          ? "If this computer is asleep then, the chat goes on when it wakes."
          : "Uno Work has to be running on this computer then."}
      </p>
    </div>
  );
});

export const ChatPlanLimitNotice = memo(function ChatPlanLimitNotice({
  environmentId,
  threadRef,
  driver,
  instanceId,
  currentModel,
  stopText,
  stoppedAt,
  lastRequest,
  smartTarget,
  canContinueWithHistory,
  onContinueWithAccount,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  driver: string | null;
  /** The provider instance the chat runs on. */
  instanceId: string | null;
  currentModel: string | null;
  /** The turn's error, or the last reply when Claude Code put the stop line there. */
  stopText: string | null;
  /** When the turn ended. */
  stoppedAt: string | null;
  /** The person's last message — typed into a new chat, never sent by itself. */
  lastRequest: string;
  smartTarget: ModelSelection | null;
  /** "Continue on…" (chat with its history) is there: the desktop app, a project chat. */
  canContinueWithHistory: boolean;
  /** The same chat goes on with that account. Only ever from the person's click. */
  onContinueWithAccount: (selection: ModelSelection) => Promise<void>;
}) {
  const provider = planProviderForDriver(driver);
  const looksLikeLimit = provider !== null && stopText !== null;
  const { computers } = usePlanComputers({ enabled: looksLikeLimit });
  const { startChatOn } = useChatOnComputer();
  const clock = useMinuteClock();
  const now = Math.max(Date.parse(clock), Date.now());
  const [busy, setBusy] = useState(false);
  const [continueOpen, setContinueOpen] = useState(false);

  const limit = looksLikeLimit
    ? chatPlanLimit({
        driver,
        instanceId,
        stopText,
        stoppedAt,
        currentEnvironmentId: environmentId,
        computers,
        now,
      })
    : null;
  if (!limit) return null;
  const alternative = limit.alternative;
  const accountHere = limit.otherAccount
    ? accountTarget(environmentId, limit.otherAccount, currentModel)
    : null;

  const continueWith = async (selection: ModelSelection) => {
    setBusy(true);
    try {
      await onContinueWithAccount(selection);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't continue with that account",
        description: errorText(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const start = async (target: EnvironmentId, modelSelection: ModelSelection | null) => {
    setBusy(true);
    try {
      await startChatOn(target, { prompt: lastRequest, modelSelection });
      // The person moved on: this chat doesn't wake up after the reset as well.
      await ensureEnvironmentApi(environmentId)
        .unoComputer.planResumeCancel({ threadId: threadRef.threadId })
        .catch(() => undefined);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't start a new chat",
        description: errorText(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-1 pb-2" data-testid="chat-plan-limit">
      <NoticeLine
        text={planFullLine({
          provider: limit.provider,
          computerName: limit.computerName,
          resetsAt: limit.resetsAt,
          now,
        })}
        testId="chat-plan-limit-line"
      >
        {accountHere ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void continueWith(accountHere.selection)}
            data-testid="chat-plan-limit-continue-with"
          >
            Continue with {accountHere.name}
          </Button>
        ) : null}
        {alternative && canContinueWithHistory ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => setContinueOpen(true)}
            data-testid="chat-plan-limit-continue"
          >
            Continue on {alternative.computerName}
          </Button>
        ) : alternative ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void start(
                alternative.environmentId,
                modelOn(alternative.environmentId, limit.provider),
              )
            }
            data-testid="chat-plan-limit-new-chat-there"
          >
            New chat on {alternative.computerName}
          </Button>
        ) : null}
        {smartTarget ? (
          <Button
            size="xs"
            variant={alternative ? "ghost" : "outline"}
            disabled={busy}
            onClick={() => void start(environmentId, smartTarget)}
            data-testid="chat-plan-limit-smart"
          >
            New chat with Uno AI
          </Button>
        ) : null}
      </NoticeLine>
      {alternative || smartTarget || accountHere ? (
        <p className="text-center text-[11px] text-muted-foreground/80">
          {accountHere
            ? "Continue with moves this chat to that account with its recent messages."
            : alternative && canContinueWithHistory
              ? "Continue moves this chat with its history. A new chat starts fresh with your last request typed in."
              : "A new chat starts fresh, with your last request typed in."}
        </p>
      ) : null}
      {alternative && canContinueWithHistory ? (
        <ContinueOnMachineDialog
          threadRef={threadRef}
          open={continueOpen}
          onOpenChange={setContinueOpen}
          initialTargetEnvironmentId={alternative.environmentId}
        />
      ) : null}
    </div>
  );
});

/**
 * Home's box ("What do you want to build?"): the same line under it when the
 * model picked there runs on a plan that is at its limit on the picked
 * computer. "Start on MacBook" switches Home's own computer chip — nothing
 * starts until the person sends. With "Switch by itself" the chip moves on
 * its own (once per computer per 15 minutes) and the line says so.
 */
export const HomePlanRoomLine = memo(function HomePlanRoomLine({
  environmentId,
  driver,
  onPickComputer,
}: {
  environmentId: EnvironmentId | null;
  driver: string | null;
  onPickComputer: (environmentId: EnvironmentId) => void;
}) {
  const provider = environmentId ? planProviderForDriver(driver) : null;
  const { computers } = usePlanComputers({ enabled: provider !== null });
  const mode = useSettings((settings) => settings.planLimitSwitch);
  const clock = useMinuteClock();
  const now = Math.max(Date.parse(clock), Date.now());
  const [switchedFrom, setSwitchedFrom] = useState<{
    readonly text: string;
    readonly to: EnvironmentId;
  } | null>(null);

  const room =
    environmentId === null
      ? ({ kind: "ok" } as const)
      : pickComputerForNewChat({ currentEnvironmentId: environmentId, provider, computers, now });
  const alternative = room.kind === "full" ? room.alternative : null;
  const movedLately =
    environmentId !== null &&
    Date.now() - (homeAutoMovedFrom.get(environmentId) ?? 0) < AUTO_MOVE_QUIET_MS;
  const autoTarget =
    mode === "auto" && alternative && !movedLately ? alternative.environmentId : null;
  useEffect(() => {
    if (autoTarget === null || environmentId === null || room.kind !== "full" || !alternative) {
      return;
    }
    homeAutoMovedFrom.set(environmentId, Date.now());
    setSwitchedFrom({
      text: planStartedOnLine({
        startedOn: alternative.computerName,
        provider: room.provider,
        blockedComputerName: room.computerName,
        resetsAt: room.resetsAt,
        now,
      }).replace(/^Started on/, "Switched to"),
      to: alternative.environmentId,
    });
    onPickComputer(alternative.environmentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per computer and target
  }, [autoTarget, environmentId]);

  if (room.kind !== "full") {
    return switchedFrom && switchedFrom.to === environmentId ? (
      <NoticeLine text={switchedFrom.text} testId="home-plan-room-switched" />
    ) : null;
  }
  return (
    <NoticeLine
      text={planFullLine({
        provider: room.provider,
        computerName: room.computerName,
        resetsAt: room.resetsAt,
        now,
      })}
      testId="home-plan-room"
    >
      {alternative ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => onPickComputer(alternative.environmentId)}
          data-testid="home-plan-room-start-on"
        >
          Start on {alternative.computerName}
        </Button>
      ) : null}
    </NoticeLine>
  );
});
