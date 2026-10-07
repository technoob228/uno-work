import { memo, useMemo, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CreditCardIcon } from "lucide-react";
import { CONSOLE_URL } from "../../account/accountOverview";
import { readLocalApi } from "../../localApi";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/** Where AI time is added to the plan on the console. */
export const UNO_BILLING_URL = `${CONSOLE_URL}/billing`;
/** Both console hosts a gateway sentence may name. */
const CONSOLE_BILLING_HOSTS = [
  "https://console.uno.place/billing",
  "https://console.uno4.dev/billing",
];
/** Where the one Uno balance is topped up (AI past the hours is paid from it). */
export const UNO_TOP_UP_URL = `${UNO_BILLING_URL}?tab=payments`;
/**
 * "Add AI time" goes straight to the AI time pack checkout (flows v2: the pack
 * is the way to more AI time; the console falls back to the plans when the
 * pack is not on sale for the account).
 */
export const UNO_ADD_AI_TIME_URL = `${UNO_BILLING_URL}?ai_pack=1`;

/** Mirrors apps/server provider/unoBilling.ts UNO_AI_CREDIT_EMPTY_MESSAGE. */
export const UNO_LLM_CREDITS_EMPTY_MESSAGE = `Your balance is empty. Top up at ${UNO_TOP_UP_URL}, add Uno AI time to your plan, or switch to your own AI subscription (Claude or ChatGPT).`;

/**
 * Openings of the server's human billing messages (apps/server
 * provider/unoBilling.ts, the gateway's own 402 wording): shown as they are.
 */
const UNO_BILLING_MESSAGE_OPENINGS = [
  "Your AI hours are used up.",
  "Your plan doesn't include Uno AI hours",
  "Your balance is empty",
  // Old gateways: a separate AI wallet.
  "Your AI credit is empty.",
  "Your premium credit is used up",
  "Your premium credit for this month is used up",
];

/**
 * The gateway's own sentence the server passed through (e.g. its
 * `premium_limit_reached` message): human words pointing at the billing page,
 * no JSON, no HTTP status.
 */
function isHumanBillingSentence(text: string): boolean {
  return (
    text.length > 0 &&
    text.length <= 800 &&
    !/[{}]/.test(text) &&
    !/\bhttp\s+\d{3}\b|\b402\b/i.test(text) &&
    !/insufficient llm credits|premium_limit_reached/i.test(text) &&
    // The gateway names the console by its own env: the old host or the new
    // one (console.uno.place since 02.10), whichever this app was built with.
    (text.includes(UNO_BILLING_URL) || CONSOLE_BILLING_HOSTS.some((url) => text.includes(url)))
  );
}

/** What the banner says: the server's own billing sentence when it has one. */
export function unoBillingBannerText(sessionError: string | null | undefined): string {
  const text = sessionError?.trim() ?? "";
  return UNO_BILLING_MESSAGE_OPENINGS.some((opening) => text.startsWith(opening)) ||
    isHumanBillingSentence(text)
    ? text
    : UNO_LLM_CREDITS_EMPTY_MESSAGE;
}

/**
 * The stop is about used-up AI time (not an empty balance): the AI time pack
 * is the way on (Misha 07.10: more AI time = the pack), so "Add AI time" leads
 * and "Top up" steps back.
 */
export function unoBillingWantsPack(sessionError: string | null | undefined): boolean {
  const text = sessionError?.trim() ?? "";
  return (
    text.startsWith("Your AI hours are used up.") ||
    /\bAI time is used up\b|\bai_pack=1\b/i.test(text)
  );
}

export const UnoBillingTopUpBanner = memo(function UnoBillingTopUpBanner({
  active,
  sessionUpdatedAt,
  sessionError,
  environmentId,
}: {
  active: boolean;
  /** Machine whose Settings → Agents connects Claude / ChatGPT subscriptions. */
  environmentId?: EnvironmentId | null;
  sessionUpdatedAt: string | null;
  /** The session's last error — tells used-up AI hours from empty credits. */
  sessionError?: string | null;
}) {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const bannerKey = useMemo(
    () => (active ? `uno-billing:${sessionUpdatedAt ?? "unknown"}` : null),
    [active, sessionUpdatedAt],
  );

  if (!active || bannerKey === null || dismissedKey === bannerKey) {
    return null;
  }
  const wantsPack = unoBillingWantsPack(sessionError);

  const topUp = async () => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Local API is unavailable.",
      });
      return;
    }

    setIsLoading(true);
    try {
      const result = await api.server.createUnoLlmTopUpAction({});
      if (result.kind === "credits_bought") {
        setDismissedKey(bannerKey);
        toastManager.add({
          type: "success",
          title: "Balance topped up.",
        });
        return;
      }

      await api.shell.openExternal(result.paymentUrl);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start Uno top-up.",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsLoading(false);
    }
  };

  const addAiHours = async () => {
    const api = readLocalApi();
    if (api) {
      try {
        await api.shell.openExternal(UNO_ADD_AI_TIME_URL);
        return;
      } catch {
        // Fall through to a plain browser tab.
      }
    }
    window.open(UNO_ADD_AI_TIME_URL, "_blank", "noopener,noreferrer");
  };

  const openOwnSubscriptionSettings = () => {
    if (!environmentId) return;
    void navigate({
      to: "/settings/environment/$environmentId/providers",
      params: { environmentId },
    });
  };

  return (
    <div className="mx-auto max-w-3xl pt-3">
      <Alert variant="warning">
        <CreditCardIcon />
        <AlertDescription>{unoBillingBannerText(sessionError)}</AlertDescription>
        <AlertAction className="flex-wrap">
          {wantsPack ? (
            <Button size="sm" type="button" onClick={() => void addAiHours()}>
              Add AI time
            </Button>
          ) : null}
          <Button
            size="sm"
            type="button"
            variant={wantsPack ? "outline" : "default"}
            onClick={() => void topUp()}
            disabled={isLoading}
          >
            {isLoading ? "Opening..." : "Top up"}
          </Button>
          {wantsPack ? null : (
            <Button size="sm" type="button" variant="outline" onClick={() => void addAiHours()}>
              Add AI time
            </Button>
          )}
          {environmentId ? (
            <Button size="sm" type="button" variant="outline" onClick={openOwnSubscriptionSettings}>
              Use my own subscription
            </Button>
          ) : null}
        </AlertAction>
      </Alert>
    </div>
  );
});
