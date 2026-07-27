import { memo, type PointerEventHandler } from "react";
import { LoaderCircleIcon, MicIcon, SquareIcon } from "lucide-react";

import { formatDictationDuration } from "~/dictation/dictationText";
import type { DictationStatus } from "~/hooks/useDictation";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerDictationButtonProps {
  status: DictationStatus;
  elapsedMs: number;
  /** Input loudness in `0..1`; drives the ring around the recording button. */
  level: number;
  disabled: boolean;
  shortcutLabel: string | null;
  preserveComposerFocusOnPointerDown?: boolean;
  onToggle: () => void;
}

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerDictationButton = memo(function ComposerDictationButton({
  status,
  elapsedMs,
  level,
  disabled,
  shortcutLabel,
  preserveComposerFocusOnPointerDown = false,
  onToggle,
}: ComposerDictationButtonProps) {
  const isRecording = status === "recording";
  const isBusy = status === "starting" || status === "transcribing";
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;

  const tooltip = isRecording
    ? "Остановить и расшифровать (Esc — отмена)"
    : status === "transcribing"
      ? "Расшифровка…"
      : shortcutLabel
        ? `Диктовка (${shortcutLabel})`
        : "Диктовка";

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {isRecording ? (
        <span
          data-chat-composer-dictation-timer="true"
          className="font-mono text-[11px] tabular-nums text-rose-500"
        >
          {formatDictationDuration(elapsedMs)}
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex shrink-0">
              <button
                type="button"
                data-chat-composer-dictation="true"
                data-dictation-status={status}
                aria-label={tooltip}
                aria-pressed={isRecording}
                disabled={disabled || isBusy}
                {...pointerFocusProps}
                onClick={onToggle}
                className={cn(
                  "relative flex size-8 items-center justify-center rounded-full transition-all duration-150",
                  "disabled:pointer-events-none disabled:opacity-40",
                  isRecording
                    ? "bg-rose-500/90 text-white hover:bg-rose-500"
                    : "cursor-pointer text-muted-foreground/70 hover:bg-accent hover:text-foreground/80",
                )}
              >
                {isRecording ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-rose-400/70 transition-transform duration-100"
                      style={{ transform: `scale(${1 + Math.min(0.45, level * 0.6)})` }}
                    />
                    <SquareIcon className="size-3 fill-current" />
                  </>
                ) : isBusy ? (
                  <LoaderCircleIcon className="size-4 animate-spin" />
                ) : (
                  <MicIcon className="size-4" />
                )}
              </button>
            </span>
          }
        />
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
    </div>
  );
});
