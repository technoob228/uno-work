import { type ApprovalRequestId, type UserInputQuestion } from "@t3tools/contracts";
import { memo, useEffect, useEffectEvent, useRef, useState } from "react";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { connectorSignedIn } from "../setup/connectorSignIn.logic";
import { useConnectorActions } from "../setup/steps/ConnectorsStep";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon, Loader2Icon, PlugIcon } from "lucide-react";
import { cn } from "~/lib/utils";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
  /**
   * Answers the active question right away — a typed value, "Skip", or an
   * app connected from the card (an assistant setting itself up, 16.10).
   */
  onAnswer?: ((questionId: string, answer: string) => void) | undefined;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onAnswer,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onAnswer={onAnswer}
    />
  );
});

/** A short field right in the card: a name, an email, a time, a link. */
function InlineAnswer(props: {
  readonly question: UserInputQuestion;
  readonly disabled: boolean;
  readonly onAnswer: (answer: string) => void;
}) {
  const [value, setValue] = useState("");
  const input = props.question.input!;
  const submit = () => {
    if (value.trim()) props.onAnswer(value.trim());
  };
  return (
    <div className="mt-3 flex items-center gap-2" data-testid="pending-input-field">
      <Input
        size="sm"
        type={input.kind === "email" ? "email" : input.kind === "url" ? "url" : "text"}
        placeholder={input.placeholder}
        value={value}
        disabled={props.disabled}
        autoFocus
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            submit();
          }
        }}
        className="flex-1"
      />
      <Button size="sm" disabled={props.disabled || !value.trim()} onClick={submit}>
        Save
      </Button>
    </div>
  );
}

/** "Connect GitHub" inside the question: the app's own page opens, the card answers itself. */
function InlineConnect(props: {
  readonly connect: NonNullable<UserInputQuestion["connect"]>;
  readonly disabled: boolean;
  readonly onConnected: () => void;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const actions = useConnectorActions(environmentId);
  const [asked, setAsked] = useState(false);
  // An expired sign-in is not "connected": the card offers Connect until it lands again.
  const connected = connectorSignedIn(actions.byProvider.get(props.connect.provider as never));
  const onConnected = useEffectEvent(props.onConnected);
  useEffect(() => {
    if (asked && connected) onConnected();
  }, [asked, connected]);
  const waiting = actions.pending?.provider === props.connect.provider;
  return (
    <div className="mt-3" data-testid="pending-input-connect">
      {connected ? (
        <div className="flex items-center gap-2 text-sm">
          <CheckIcon className="size-4 text-success" />
          {props.connect.name} is connected
          {asked ? null : (
            <Button size="xs" variant="outline" onClick={props.onConnected}>
              Use it
            </Button>
          )}
        </div>
      ) : (
        <Button
          size="sm"
          disabled={props.disabled || waiting}
          onClick={() => {
            setAsked(true);
            void actions.connect(props.connect.provider as never);
          }}
        >
          {waiting ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <PlugIcon className="size-3.5" />
          )}
          {waiting ? `Waiting for ${props.connect.name}…` : `Connect ${props.connect.name}`}
        </Button>
      )}
    </div>
  );
}

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
  onAnswer,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
  onAnswer?: ((questionId: string, answer: string) => void) | undefined;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);

  useEffect(() => {
    onAdvanceRef.current = onAdvance;
  }, [onAdvance]);

  // Clear auto-advance timer on unmount
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    };
  }, []);

  const handleOptionSelection = useEffectEvent((questionId: string, optionLabel: string) => {
    onToggleOption(questionId, optionLabel);
    if (activeQuestion?.multiSelect) {
      return;
    }
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current);
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null;
      onAdvanceRef.current();
    }, 200);
  });

  // Keyboard shortcut: number keys 1-9 select corresponding options when focus is
  // outside editable fields. Multi-select prompts toggle options in place; single-
  // select prompts keep the existing auto-advance behavior.
  useEffect(() => {
    if (!activeQuestion || isResponding) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
      const optionIndex = digit - 1;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(activeQuestion.id, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding]);

  if (!activeQuestion) {
    return null;
  }
  // The answer a Connect button sends isn't an option to click.
  const shownOptions = activeQuestion.options.filter(
    (option) => option.label !== activeQuestion.connect?.doneLabel,
  );

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          {prompt.questions.length > 1 ? (
            <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
              {questionIndex + 1}/{prompt.questions.length}
            </span>
          ) : null}
          <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/50 uppercase">
            {activeQuestion.header}
          </span>
        </div>
      </div>
      <p className="mt-1.5 text-sm text-foreground/90">{activeQuestion.question}</p>
      {activeQuestion.detail ? (
        <p className="mt-1 text-xs leading-snug text-muted-foreground">{activeQuestion.detail}</p>
      ) : null}
      {activeQuestion.connect && onAnswer ? (
        <InlineConnect
          connect={activeQuestion.connect}
          disabled={isResponding}
          onConnected={() => onAnswer(activeQuestion.id, activeQuestion.connect!.doneLabel)}
        />
      ) : null}
      {activeQuestion.input && onAnswer ? (
        <InlineAnswer
          key={activeQuestion.id}
          question={activeQuestion}
          disabled={isResponding}
          onAnswer={(answer) => onAnswer(activeQuestion.id, answer)}
        />
      ) : null}
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-xs text-muted-foreground/65">Select one or more options.</p>
      ) : null}
      <div className="mt-3 space-y-1">
        {shownOptions.map((option, index) => {
          const isSelected = progress.selectedOptionLabels.includes(option.label);
          const shortcutKey = index < 9 ? index + 1 : null;
          return (
            <button
              key={`${activeQuestion.id}:${option.label}`}
              type="button"
              disabled={isResponding}
              onClick={() => handleOptionSelection(activeQuestion.id, option.label)}
              className={cn(
                "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all duration-150",
                isSelected
                  ? "border-blue-500/40 bg-blue-500/8 text-foreground"
                  : "border-transparent bg-muted/20 text-foreground/80 hover:bg-muted/40 hover:border-border/40",
                isResponding && "opacity-50 cursor-not-allowed",
              )}
            >
              {shortcutKey !== null ? (
                <kbd
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-medium tabular-nums transition-colors duration-150",
                    isSelected
                      ? "bg-blue-500/20 text-blue-400"
                      : "bg-muted/40 text-muted-foreground/50 group-hover:bg-muted/60 group-hover:text-muted-foreground/70",
                  )}
                >
                  {shortcutKey}
                </kbd>
              ) : null}
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="ml-2 text-xs text-muted-foreground/50">
                    {option.description}
                  </span>
                ) : null}
              </div>
              {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-blue-400" /> : null}
            </button>
          );
        })}
      </div>
      {activeQuestion.skippable && onAnswer ? (
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{activeQuestion.input ? "" : "Or type your own answer below."}</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={isResponding}
            onClick={() => onAnswer(activeQuestion.id, "Skip")}
            data-testid="pending-input-skip"
          >
            Skip
          </Button>
        </div>
      ) : null}
    </div>
  );
});
