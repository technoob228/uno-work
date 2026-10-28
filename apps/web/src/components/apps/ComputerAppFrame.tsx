/**
 * A web app of the computer at its local address (`http://localhost:<port>/…`),
 * shown natively in this browser — the app's window, an app tab in the right
 * panel (P16, 28.10: "an app or a widget works inside Uno Work by default").
 *
 *   - a cloud computer: the page comes from the port's own address
 *     (`https://p{PORT}--{LABEL}.uno4.work`, portPreview.ts) — a frame of this
 *     browser, no stream, no ping;
 *   - the person's own Mac/PC (a local daemon): its localhost is right here.
 *
 * When this browser can't get the port's address (the account doesn't have
 * it yet, the computer isn't reachable) the window says so and offers Try
 * again; the computer's own screen (the agent's browser, streamed) is only
 * the person's explicit choice, never where the app lands by itself.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { MonitorIcon, RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useCloudComputer, usePortFrame, type PortLinkFailure } from "../preview/portPreview";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { AppFrame } from "./AppFrame";
import { ComputerAppPage } from "./ComputerAppPage";

export function computerAppUnavailableText(name: string, reason: PortLinkFailure): string {
  return reason === "disabled"
    ? `${name} is running on your cloud computer, but this account can't show it inside Uno Work yet.`
    : `${name} is running on your cloud computer, but Uno Work couldn't reach it from this browser right now.`;
}

export function ComputerAppFrame({
  environmentId,
  url,
  name,
  icon = null,
  reloadKey = 0,
  compact = false,
  className,
}: {
  environmentId: EnvironmentId | null;
  /** The app's local address on the computer, e.g. `http://localhost:8471/`. */
  url: string;
  name: string;
  icon?: string | null;
  reloadKey?: number;
  compact?: boolean;
  className?: string;
}) {
  const computer = useCloudComputer(environmentId);
  const { state, retry } = usePortFrame({ localUrl: computer ? url : null, computer });
  const [onScreen, setOnScreen] = useState(false);

  // The person's own machine: its localhost is this device's.
  if (!computer) {
    return (
      <AppFrame
        url={url}
        name={name}
        icon={icon}
        reloadKey={reloadKey}
        compact={compact}
        {...(className ? { className } : {})}
      />
    );
  }
  if (onScreen && environmentId) {
    return <ComputerAppPage environmentId={environmentId} url={url} name={name} />;
  }
  if (state.kind === "ready") {
    return (
      <AppFrame
        url={state.url}
        firstSrc={state.firstSrc}
        name={name}
        icon={icon}
        reloadKey={reloadKey}
        compact={compact}
        portAddress
        {...(className ? { className } : {})}
      />
    );
  }
  if (state.kind === "failed") {
    return (
      <div
        className={cn(
          "flex h-full flex-col items-center justify-center gap-3 px-6 text-center",
          className,
        )}
        data-testid="computer-app-unavailable"
      >
        <div className="max-w-md">
          <h2
            className={cn("font-semibold text-foreground", compact ? "text-sm" : "text-base")}
          >{`Can't show ${name} here yet`}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {computerAppUnavailableText(name, state.reason)}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" variant="outline" onClick={retry}>
            <RotateCwIcon />
            Try again
          </Button>
          {environmentId ? (
            <Button size="sm" variant="ghost" onClick={() => setOnScreen(true)}>
              <MonitorIcon />
              View it on the computer's screen
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className={cn("flex h-full items-center justify-center", className)}>
      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Opening {name}…
      </span>
    </div>
  );
}
