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
}: {
  error: string | null;
  onDismiss?: () => void;
  /** Sends the person's last message again; absent when there is nothing to resend. */
  onRetry?: (() => void) | undefined;
  retryDisabled?: boolean;
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
