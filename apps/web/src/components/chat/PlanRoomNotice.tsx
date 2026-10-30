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
 *   and one click on: "Continue on MacBook" (the chat with its history, the
 *   desktop app), or "New chat on MacBook" / "New chat with Uno AI" with the
 *   last request typed in.
 */
import type { DraftId } from "../../composerDraftStore";
import type { EnvironmentId, ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { useChatOnComputer } from "../../hooks/useFolderChats";
import { useSettings } from "../../hooks/useSettings";
import { readEnvironmentServerConfig } from "../../environments/settings/serverSettings";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import {
  chatPlanLimit,
  DRIVER_BY_PLAN_PROVIDER,
  pickComputerForNewChat,
  planFullLine,
  planProviderForDriver,
  planStartedOnLine,
  type PlanProvider,
} from "../../planRoom/planRoom.logic";
import { usePlanComputers } from "../../planRoom/usePlanComputers";
import { pickUsableModelSelectionForDriver } from "../../providerModels";
import { ContinueOnMachineDialog } from "../ContinueOnMachineDialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The model to start on there: that computer's own sign-in of the same plan. */
function modelOn(environmentId: EnvironmentId, provider: PlanProvider): ModelSelection | null {
  const providers = readEnvironmentServerConfig(environmentId)?.providers ?? [];
  return pickUsableModelSelectionForDriver(providers, DRIVER_BY_PLAN_PROVIDER[provider]);
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
  onUseModel,
  smartTarget,
}: {
  environmentId: EnvironmentId;
  draftId: DraftId;
  /** The harness the new chat would start on now (`claudeAgent`, `codex`, `uno`…). */
  driver: string | null;
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
    computers,
    now,
  });
  const alternative = room.kind === "full" ? room.alternative : null;
  const startedText = readStartedNote(environmentId, draftId);

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
  const autoTarget = mode === "auto" && alternative ? alternative.environmentId : null;
  useEffect(() => {
    if (autoTarget === null || autoMovedRef.current === draftId) return;
    autoMovedRef.current = draftId;
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

export const ChatPlanLimitNotice = memo(function ChatPlanLimitNotice({
  environmentId,
  threadRef,
  driver,
  stopText,
  lastRequest,
  smartTarget,
  canContinueWithHistory,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  driver: string | null;
  /** The turn's error, or the last reply when Claude Code put the stop line there. */
  stopText: string | null;
  /** The person's last message — typed into a new chat, never sent by itself. */
  lastRequest: string;
  smartTarget: ModelSelection | null;
  /** "Continue on…" (chat with its history) is there: the desktop app, a project chat. */
  canContinueWithHistory: boolean;
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
        stopText,
        currentEnvironmentId: environmentId,
        computers,
        now,
      })
    : null;
  if (!limit) return null;
  const alternative = limit.alternative;

  const start = async (target: EnvironmentId, modelSelection: ModelSelection | null) => {
    setBusy(true);
    try {
      await startChatOn(target, { prompt: lastRequest, modelSelection });
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
      {alternative || smartTarget ? (
        <p className="text-center text-[11px] text-muted-foreground/80">
          {alternative && canContinueWithHistory
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
