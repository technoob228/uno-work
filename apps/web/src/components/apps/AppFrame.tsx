/**
 * One of the computer's web apps (Nextcloud, Vaultwarden, Open WebUI…) shown
 * inside Uno Work — in the main area or in the right panel.
 *
 * Desktop app: an Electron `<webview>` with its own persistent session, which
 * no frame header can refuse. Browser: an iframe, after the daemon has read
 * the app's X-Frame-Options / CSP `frame-ancestors` (`uno.computer.embedCheck`)
 * — the browser can't see why a frame stays blank, the daemon can. An app that
 * refuses to be framed gets an honest card with "Open in a new tab" instead of
 * the browser's grey "refused to connect".
 */
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";

import { isElectron } from "../../env";
import { ensureEnvironmentApi } from "../../environmentApi";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { cn } from "../../lib/utils";
import { openInNewTab } from "../../navigation/useOpenApp";
import { ProgramIcon } from "../computer/ComputerPrograms";
import { originOf } from "../computer/useProgramTiles";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

/**
 * The app runs as itself (scripts, its own cookies, forms, downloads, popups
 * such as "sign in with…"), but may not navigate Uno Work away: no
 * allow-top-navigation, so frame-busting scripts stay inside the frame.
 */
const FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-storage-access-by-user-activation";

const FRAME_ALLOW =
  "clipboard-read; clipboard-write; fullscreen; camera; microphone; display-capture; autoplay";

export function AppFrame({
  url,
  name,
  icon,
  reloadKey = 0,
  compact = false,
  className,
}: {
  url: string;
  name: string;
  icon?: string | null;
  /** Bump to reload the app. */
  reloadKey?: number;
  /** The right panel: a smaller "can't show it here" card. */
  compact?: boolean;
  className?: string;
}) {
  if (isElectron) {
    return (
      <webview
        key={`${url}#${reloadKey}`}
        src={url}
        partition="persist:uno-apps"
        allowpopups
        className={cn("h-full w-full", className)}
        style={{ display: "flex" }}
      />
    );
  }
  return (
    <BrowserAppFrame
      url={url}
      name={name}
      icon={icon ?? null}
      reloadKey={reloadKey}
      compact={compact}
      className={className}
    />
  );
}

function BrowserAppFrame({
  url,
  name,
  icon,
  reloadKey,
  compact,
  className,
}: {
  url: string;
  name: string;
  icon: string | null;
  reloadKey: number;
  compact: boolean;
  className: string | undefined;
}) {
  const { environmentId } = useActiveMachine();
  const embedderOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const check = useQuery({
    queryKey: ["uno-embed-check", environmentId, originOf(url), embedderOrigin],
    queryFn: () =>
      ensureEnvironmentApi(environmentId!).unoComputer.embedCheck({ url, embedderOrigin }),
    enabled: environmentId !== null,
    staleTime: 60_000,
    retry: false,
  });

  if (check.isPending && environmentId !== null) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (check.data?.verdict === "blocked") {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-4 overflow-y-auto px-6 text-center",
          className,
        )}
      >
        <ProgramIcon
          name={name}
          icon={icon}
          iconImage={null}
          {...(compact ? { className: "size-12" } : {})}
        />
        <div className="max-w-md">
          <h2 className="text-base font-semibold text-foreground">{name} opens in its own tab</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {name} protects itself from being shown inside other pages, so Uno Work can't show it
            here. It opens in a new browser tab, and Uno Work stays open in this one.
          </p>
        </div>
        <Button onClick={() => openInNewTab(url)}>
          <ExternalLinkIcon />
          Open {name} in a new tab
        </Button>
      </div>
    );
  }

  // Unknown (the app didn't answer, or an older computer can't check): try.
  return (
    <iframe
      key={`${url}#${reloadKey}`}
      src={url}
      title={name}
      allow={FRAME_ALLOW}
      sandbox={FRAME_SANDBOX}
      referrerPolicy="strict-origin-when-cross-origin"
      className={cn("h-full w-full border-0 bg-background", className)}
    />
  );
}
