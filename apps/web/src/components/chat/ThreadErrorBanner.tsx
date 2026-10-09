import { CircleAlertIcon, HourglassIcon, RotateCwIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  BUSY_AUTO_RETRY_COOLDOWN_MS,
  TURN_ERROR_COPY as COPY,
  classifyTurnError,
} from "./turnErrorNotice";

/** When "busy" was last retried by itself, per chat: one automatic retry, then the person decides. */
const autoRetriedAt = new Map<string, number>();

/** Tests only. */
export function resetTurnErrorAutoRetries(): void {
  autoRetriedAt.clear();
}

/**
 * A failed turn above the composer.
 *
 * "AI is busy" and "the model didn't answer" (turnErrorNotice.ts) are calm
 * lines with "Try again": nothing is lost, the person's last message is sent
 * again. "Busy" counts down and retries once by itself. Any other error keeps
 * its own text; with `onRetry` it gets the same button, without it — the old
 * red alert.
 */
export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  errorKey,
  threadKey,
  onDismiss,
  onRetry,
  retryDisabled = false,
  subscriptionLabel,
  onUseUnoAi,
}: {
  error: string | null;
  /** Changes when a new error arrives (same text twice is two errors). */
  errorKey?: string | null;
  /** The chat, for "one automatic retry per chat". */
  threadKey?: string | null;
  onDismiss?: () => void;
  /** Sends the person's last message again; absent when there is nothing to resend. */
  onRetry?: (() => void) | undefined;
  retryDisabled?: boolean;
  /** "Claude" / "ChatGPT": whose subscription limit a "subscription-limit" error is. */
  subscriptionLabel?: string | undefined;
  /** Opens a new chat on Uno AI; offered when the person's own subscription is out. */
  onUseUnoAi?: (() => void) | undefined;
}) {
  const notice = error ? classifyTurnError(error) : null;
  const busy = notice?.kind === "busy";
  const identity = error ? `${threadKey ?? ""}|${errorKey ?? ""}|${error}` : null;
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;

  // Decided once per error: does this "busy" still have its automatic retry?
  const [countdown, setCountdown] = useState<number | null>(null);
  const [stillBusy, setStillBusy] = useState(false);
  useEffect(() => {
    if (!identity || !busy || !notice) {
      setCountdown(null);
      setStillBusy(false);
      return;
    }
    const chat = threadKey ?? "";
    const last = autoRetriedAt.get(chat);
    const usedUp = last !== undefined && Date.now() - last < BUSY_AUTO_RETRY_COOLDOWN_MS;
    setStillBusy(usedUp);
    setCountdown(usedUp || !onRetryRef.current ? null : notice.retryAfterSeconds);
    // `notice` is derived from `error`, which is part of `identity`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, busy, threadKey]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      setCountdown(null);
      if (retryDisabled || !onRetryRef.current) return;
      autoRetriedAt.set(threadKey ?? "", Date.now());
      onRetryRef.current();
      return;
    }
    const timer = setTimeout(
      () => setCountdown((value) => (value === null ? null : value - 1)),
      1_000,
    );
    return () => clearTimeout(timer);
  }, [countdown, retryDisabled, threadKey]);

  if (!error || !notice) return null;

  const dismiss = onDismiss ? (
    <button
      type="button"
      aria-label="Dismiss"
      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:text-foreground"
      onClick={onDismiss}
    >
      <XIcon className="size-3.5" />
    </button>
  ) : null;

  if (notice.kind === "other" && !onRetry) {
    return (
      <div className="pt-3 mx-auto max-w-3xl">
        <Alert variant="error">
          <CircleAlertIcon />
          <AlertDescription className="line-clamp-3" title={error}>
            {error}
          </AlertDescription>
          {onDismiss && (
            <AlertAction>
              <button
                type="button"
                aria-label="Dismiss error"
                className="inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
                onClick={onDismiss}
              >
                <XIcon className="size-3.5" />
              </button>
            </AlertAction>
          )}
        </Alert>
      </div>
    );
  }

  const text =
    notice.kind === "busy"
      ? stillBusy
        ? COPY.stillBusy
        : countdown !== null
          ? COPY.busyCountdown(countdown)
          : COPY.busyNoRetry
      : notice.kind === "no-answer"
        ? COPY.noAnswer
        : notice.kind === "subscription-limit"
          ? COPY.subscriptionLimit(
              subscriptionLabel ?? "AI",
              notice.resetsAt,
              onUseUnoAi !== undefined,
            )
          : error;
  const retryLabel = notice.kind === "busy" && countdown !== null ? COPY.retryNow : COPY.retry;
  const retry = () => {
    setCountdown(null);
    if (notice.kind === "busy") autoRetriedAt.set(threadKey ?? "", Date.now());
    onRetry?.();
  };

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant="default" data-testid="turn-error-notice" data-kind={notice.kind}>
        {notice.kind === "busy" ? <HourglassIcon /> : <RotateCwIcon />}
        <AlertDescription
          className={notice.kind === "other" ? "line-clamp-3" : undefined}
          title={notice.kind === "other" ? error : undefined}
        >
          {text}
        </AlertDescription>
        <AlertAction className="items-center">
          {notice.kind === "subscription-limit" && onUseUnoAi ? (
            <Button
              size="xs"
              type="button"
              data-testid="turn-error-use-uno-ai"
              onClick={onUseUnoAi}
            >
              {COPY.newChatOnUnoAi}
            </Button>
          ) : null}
          {onRetry ? (
            <Button
              size="xs"
              variant="outline"
              type="button"
              data-testid="turn-error-retry"
              disabled={retryDisabled}
              onClick={retry}
            >
              {retryLabel}
            </Button>
          ) : null}
          {dismiss}
        </AlertAction>
      </Alert>
    </div>
  );
});
