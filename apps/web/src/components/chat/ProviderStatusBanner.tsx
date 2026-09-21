import { type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon } from "lucide-react";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { isWebApp } from "../../webMode";

export interface ProviderStatusBannerAction {
  readonly label: string;
  readonly onClick: () => void;
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
  action,
  hint,
}: {
  status: ServerProvider | null;
  /**
   * Optional escape hatch rendered as a button — e.g. "Switch to built-in
   * Uno AI" when the selected harness is not signed in but the Uno gateway
   * is live. Supplied by the caller so the banner stays presentation-only.
   */
  action?: ProviderStatusBannerAction | null;
  /**
   * Optional extra sentence appended to the description when no direct
   * action is possible (e.g. the thread is already locked to this harness,
   * so the fix is "start a new chat").
   */
  hint?: string | null;
}) {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  // В браузерной версии набор харнесов задан образом машины, а не действиями
  // пользователя. «Codex CLI is not installed» — это факт о нашей сборке, а не
  // проблема, которую он может решить: показывать её в чате незачем, ставить
  // харнес всё равно нужно в терминале. Реальные сбои (auth, error) остаются.
  if (isWebApp && status.installed === false) {
    return null;
  }

  const providerLabel = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const defaultMessage =
    status.status === "error"
      ? `The ${providerLabel} agent is unavailable.`
      : `The ${providerLabel} agent has limited availability.`;
  const title = `${providerLabel} agent status`;
  const message = status.message ?? defaultMessage;
  const description = hint ? `${message} ${hint}` : message;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={description}>
          {description}
        </AlertDescription>
        {action ? (
          <div className="mt-2">
            <Button size="xs" variant="outline" onClick={action.onClick}>
              {action.label}
            </Button>
          </div>
        ) : null}
      </Alert>
    </div>
  );
});
