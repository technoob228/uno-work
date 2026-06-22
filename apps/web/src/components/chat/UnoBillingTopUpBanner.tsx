import { memo, useMemo, useState } from "react";
import { CreditCardIcon } from "lucide-react";
import { readLocalApi } from "../../localApi";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export const UNO_LLM_CREDITS_EMPTY_MESSAGE = "Uno LLM credits are empty.";

export const UnoBillingTopUpBanner = memo(function UnoBillingTopUpBanner({
  active,
  sessionUpdatedAt,
}: {
  active: boolean;
  sessionUpdatedAt: string | null;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const bannerKey = useMemo(
    () => (active ? `uno-billing:${sessionUpdatedAt ?? "unknown"}` : null),
    [active, sessionUpdatedAt],
  );

  if (!active || bannerKey === null || dismissedKey === bannerKey) {
    return null;
  }

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
          title: "Uno LLM credits topped up.",
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

  return (
    <div className="mx-auto max-w-3xl pt-3">
      <Alert variant="warning">
        <CreditCardIcon />
        <AlertDescription>{UNO_LLM_CREDITS_EMPTY_MESSAGE}</AlertDescription>
        <AlertAction>
          <Button size="sm" type="button" onClick={() => void topUp()} disabled={isLoading}>
            {isLoading ? "Opening..." : "Top up"}
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});
