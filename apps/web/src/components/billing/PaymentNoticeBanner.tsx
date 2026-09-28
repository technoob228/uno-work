/**
 * Overdue payment: the console's `payment_notice` (on /api/v1/box-subscription)
 * shown across the app while signed in to an Uno account.
 *
 * Title, message, button label and link are rendered exactly as the backend
 * sends them — no copy or date formatting of our own. The notice can be hidden
 * for the rest of the session, never for good: a new state, date or wording
 * brings it back, and so does the next launch.
 */
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { CreditCardIcon, XIcon } from "lucide-react";
import { memo, useState } from "react";

import { type PaymentNotice, paymentNoticeKey } from "../../account/accountOverview";
import { cn } from "../../lib/utils";
import { openInNewTab } from "../../navigation/useOpenApp";
import { subscriptionQuery } from "../myuno/myUnoQueries";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

/** The app-wide banner re-reads the subscription this often (at most). */
const PAYMENT_NOTICE_POLL_MS = 5 * 60_000;
const DISMISS_STORAGE_KEY = "uno.paymentNotice.dismissed";

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(key: string): void {
  try {
    window.sessionStorage.setItem(DISMISS_STORAGE_KEY, key);
  } catch {
    // Private mode etc.: the dismiss still holds in memory.
  }
}

/** The subscription's payment notice, or null (signed out, no plan, all paid, error). */
export function usePaymentNotice(): PaymentNotice | null {
  const subscription = useQuery({
    ...subscriptionQuery(),
    refetchInterval: PAYMENT_NOTICE_POLL_MS,
  });
  return subscription.data?.paymentNotice ?? null;
}

export const PaymentNoticeCard = memo(function PaymentNoticeCard({
  notice,
  onDismiss,
  className,
}: {
  notice: PaymentNotice;
  onDismiss?: () => void;
  className?: string;
}) {
  const actionUrl = notice.actionUrl;
  return (
    <Alert
      variant={notice.severity === "critical" ? "error" : "warning"}
      className={className}
      data-testid="payment-notice"
      data-state={notice.state}
    >
      <CreditCardIcon />
      {notice.title ? <AlertTitle>{notice.title}</AlertTitle> : null}
      {notice.message ? <AlertDescription>{notice.message}</AlertDescription> : null}
      {actionUrl || onDismiss ? (
        <AlertAction className="items-center">
          {actionUrl ? (
            <Button size="sm" type="button" onClick={() => openInNewTab(actionUrl)}>
              {notice.actionLabel ?? actionUrl}
            </Button>
          ) : null}
          {onDismiss ? (
            <Button
              size="icon-sm"
              type="button"
              variant="ghost"
              aria-label="Hide for now"
              onClick={onDismiss}
            >
              <XIcon />
            </Button>
          ) : null}
        </AlertAction>
      ) : null}
    </Alert>
  );
});

/**
 * Floats over the top of the workspace in the app shell. Hidden on My Uno,
 * which shows the same notice inline in its overview.
 */
export function PaymentNoticeBanner() {
  const notice = usePaymentNotice();
  const onMyUno = useLocation({ select: (location) => location.pathname.startsWith("/my-uno") });
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);

  if (!notice || onMyUno) return null;
  const key = paymentNoticeKey(notice);
  if (dismissed === key) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-4">
      <div
        className={cn(
          "pointer-events-auto w-full max-w-2xl rounded-xl bg-background shadow-lg",
          "[-webkit-app-region:no-drag]",
        )}
      >
        <PaymentNoticeCard
          notice={notice}
          onDismiss={() => {
            writeDismissed(key);
            setDismissed(key);
          }}
        />
      </div>
    </div>
  );
}
