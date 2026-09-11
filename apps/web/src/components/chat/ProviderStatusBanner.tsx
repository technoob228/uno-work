import { type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon } from "lucide-react";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { isWebApp } from "../../webMode";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
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

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
      </Alert>
    </div>
  );
});
