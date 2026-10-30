import { CircleAlertIcon, CirclePauseIcon, HourglassIcon, RotateCwIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  TURN_ERROR_COPY as COPY,
  classifyTurnError,
  isRestartCutOffError,
} from "./turnErrorNotice";

/**
 * A failed turn above the composer.
 *
 * "AI is busy" and "the model didn't answer" (turnErrorNotice.ts) are calm
 * lines with "Try again": nothing is lost, the person's last message is sent
 * again. No countdown and no retry of its own here: the daemon already
 * continued the turn by itself (turnErrorRetry, up to two times, with or
 * without a tab open) before such an error reaches the chat — retrying again
 * from the tab would double it. Any other error keeps its own text; with
 * `onRetry` it gets the same button, without it — the old red alert.
 */
export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  onRetry,
  retryDisabled = false,
  placement = "banner",
}: {
  error: string | null;
  onDismiss?: () => void;
  /** Sends the person's last message again; absent when there is nothing to resend. */
  onRetry?: (() => void) | undefined;
  retryDisabled?: boolean;
  /**
   * `feed`: one quiet line at the end of the chat, right under the last
   * message, instead of a plate above it (upstream bd3287b640 #25401, the idea).
   */
  placement?: "banner" | "feed";
}) {
  const notice = error ? classifyTurnError(error) : null;

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

  // Cut off by a restart: a plain line, not a red error and not "Try again"
  // (that would send the person's message again and start the work over).
  if (isRestartCutOffError(error)) {
    if (placement === "feed") {
      return (
        <div
          className="flex min-w-0 items-center gap-1.5 px-1 pb-2 text-xs text-muted-foreground"
          data-testid="turn-error-notice"
          data-kind="restart"
          role="status"
        >
          <CirclePauseIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 line-clamp-2">{COPY.restart}</span>
          {dismiss}
        </div>
      );
    }
    return (
      <div className="pt-3 mx-auto max-w-3xl">
        <Alert variant="default" data-testid="turn-error-notice" data-kind="restart">
          <CirclePauseIcon />
          <AlertDescription>{COPY.restart}</AlertDescription>
          {dismiss ? <AlertAction className="items-center">{dismiss}</AlertAction> : null}
        </Alert>
      </div>
    );
  }

  if (placement === "feed") {
    const lineText =
      notice.kind === "busy" ? COPY.stillBusy : notice.kind === "no-answer" ? COPY.noAnswer : error;
    // Red only for an error with nothing to try again; the rest is calm (flows v2, I1).
    const alarming = notice.kind === "other" && !onRetry;
    const Icon = notice.kind === "busy" ? HourglassIcon : alarming ? CircleAlertIcon : RotateCwIcon;
    return (
      <div
        className="flex min-w-0 items-center gap-1.5 px-1 pb-2 text-xs text-muted-foreground"
        data-testid="turn-error-notice"
        data-kind={notice.kind}
        role="status"
      >
        <Icon
          aria-hidden
          className={alarming ? "size-3.5 shrink-0 text-destructive/80" : "size-3.5 shrink-0"}
        />
        <span className="min-w-0 line-clamp-2" title={error}>
          {lineText}
        </span>
        {onRetry ? (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              data-testid="turn-error-retry"
              disabled={retryDisabled}
              onClick={onRetry}
              className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-50"
            >
              {COPY.retry}
            </button>
          </>
        ) : null}
        {dismiss}
      </div>
    );
  }

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
    notice.kind === "busy" ? COPY.stillBusy : notice.kind === "no-answer" ? COPY.noAnswer : error;

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
          {onRetry ? (
            <Button
              size="xs"
              variant="outline"
              type="button"
              data-testid="turn-error-retry"
              disabled={retryDisabled}
              onClick={onRetry}
            >
              {COPY.retry}
            </Button>
          ) : null}
          {dismiss}
        </AlertAction>
      </Alert>
    </div>
  );
});
