/**
 * One program, up close: what it is, whether it runs, where it answers, and
 * the few things a person does with it — Open, Show on the internet / Hide,
 * Start / Stop. "Show on the internet" is the only way a port gets published,
 * and it says plainly what it does before it does it.
 */
import type { UnoMachineAppAction, UnoMachineApps } from "@t3tools/contracts";
import {
  CirclePlayIcon,
  CircleStopIcon,
  ExternalLinkIcon,
  EyeOffIcon,
  GlobeIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { displayAddress } from "./computerFormat";
import { ProgramIcon } from "./ComputerPrograms";
import { CopyButton } from "./computerUi";
import type { ProgramTile } from "./programModel";

const STATUS_WORD: Record<ProgramTile["status"], string> = {
  running: "Running",
  stopped: "Stopped",
  installing: "Installing…",
  failed: "Didn't start",
  asleep: "Asleep with the computer",
  unknown: "Status unknown",
};

function AddressRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-xl bg-muted/40 py-1.5 pr-1.5 pl-3">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="truncate font-mono text-xs" title={url}>
          {displayAddress(url)}
        </div>
      </div>
      <CopyButton value={url} label={label.toLowerCase()} />
      <Button
        size="xs"
        variant="outline"
        render={<a href={url} target="_blank" rel="noopener noreferrer" />}
      >
        <ExternalLinkIcon />
        Open
      </Button>
    </div>
  );
}

export function ProgramDialog({
  tile,
  machineApps,
  browserOnMachine,
  pendingAction,
  actionError,
  onAction,
  onClose,
}: {
  tile: ProgramTile | null;
  machineApps: UnoMachineApps | undefined;
  browserOnMachine: boolean;
  pendingAction: UnoMachineAppAction | null;
  actionError: string | null;
  onAction: (appId: string, action: UnoMachineAppAction) => void;
  onClose: () => void;
}) {
  const app = tile?.machineApp ?? null;
  const publication = app?.publication ?? null;
  const publishable =
    app !== null &&
    app.status === "running" &&
    (app.port !== null || app.udpPorts.length > 0) &&
    !app.loopbackOnly;
  const blocked = machineApps?.publishBlockedReason ?? null;
  const busy = pendingAction !== null;
  const nonWebForwards = publication?.forwards.filter(
    (f) => f.protocol !== "tcp" || !app?.http || publication.url === null,
  );

  return (
    <Dialog open={tile !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-lg">
        {tile ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-4">
                <ProgramIcon name={tile.name} icon={tile.icon} iconImage={tile.iconImage} />
                <div className="min-w-0">
                  <DialogTitle className="truncate">{tile.name}</DialogTitle>
                  <DialogDescription className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        tile.status === "running"
                          ? "bg-success"
                          : tile.status === "failed"
                            ? "bg-destructive"
                            : "bg-muted-foreground/60",
                      )}
                      aria-hidden
                    />
                    {STATUS_WORD[tile.status]}
                    {app?.detail ? <span className="truncate">· {app.detail}</span> : null}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-3">
              {app?.description ? (
                <p className="text-sm leading-relaxed text-muted-foreground">{app.description}</p>
              ) : null}

              {app?.url ? <AddressRow label="Its address" url={app.url} /> : null}
              {tile.storeApp?.url || tile.install?.url ? (
                <AddressRow
                  label="On the internet"
                  url={(tile.storeApp?.url ?? tile.install?.url)!}
                />
              ) : null}
              {publication?.url ? (
                <AddressRow label="On the internet" url={publication.url} />
              ) : null}
              {nonWebForwards && nonWebForwards.length > 0 && publication?.host ? (
                <div className="rounded-xl bg-muted/40 px-3 py-2 text-xs">
                  <div className="text-[11px] text-muted-foreground">
                    Connect from outside with the app's own client
                  </div>
                  <ul className="mt-1 flex flex-col gap-0.5 font-mono">
                    {nonWebForwards.map((f) => (
                      <li key={f.forwardId}>
                        {publication.host}:{f.externalPort ?? "…"}{" "}
                        <span className="text-muted-foreground">
                          ({f.protocol.toUpperCase()}, port {f.internalPort} inside)
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {app?.localUrl && browserOnMachine && app.status === "running" ? (
                <AddressRow label="On this computer" url={app.localUrl} />
              ) : app && app.port !== null && app.status === "running" && !publication ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  It answers on port {app.port} inside this computer. To open it from anywhere —
                  this browser, your phone, a friend — show it on the internet.
                </p>
              ) : null}

              {app?.loopbackOnly && app.status === "running" ? (
                <p className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-xs leading-relaxed">
                  <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  It only listens inside the computer (127.0.0.1), so it can't be shown on the
                  internet. Ask Uno to make it listen on all addresses (0.0.0.0).
                </p>
              ) : null}

              {app && !publication && publishable ? (
                blocked ? (
                  <p className="text-xs text-muted-foreground">{blocked}</p>
                ) : (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    <strong className="font-medium text-foreground">Show on the internet</strong>{" "}
                    gives it a public address. Anyone with the address can reach it, so do it for
                    things that have their own login or are meant to be public.
                  </p>
                )
              ) : null}

              {actionError ? (
                <p className="text-xs text-destructive" role="alert">
                  {actionError}
                </p>
              ) : null}

              {app ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  {publication ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onAction(app.id, "unpublish")}
                    >
                      {pendingAction === "unpublish" ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <EyeOffIcon />
                      )}
                      Hide from the internet
                    </Button>
                  ) : publishable && !blocked ? (
                    <Button size="sm" disabled={busy} onClick={() => onAction(app.id, "publish")}>
                      {pendingAction === "publish" ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <GlobeIcon />
                      )}
                      Show on the internet
                    </Button>
                  ) : null}
                  {app.canStop ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onAction(app.id, "stop")}
                    >
                      {pendingAction === "stop" ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <CircleStopIcon />
                      )}
                      Stop
                    </Button>
                  ) : null}
                  {app.canStart ? (
                    <Button
                      size="sm"
                      variant={publication ? "outline" : "default"}
                      disabled={busy}
                      onClick={() => onAction(app.id, "start")}
                    >
                      {pendingAction === "start" ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <CirclePlayIcon />
                      )}
                      Start
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {app && !app.canStop && app.status === "running" && app.source === "systemd" ? (
                <p className="text-[11px] text-muted-foreground">
                  A system service: starting and stopping it needs an admin (the terminal with
                  sudo).
                </p>
              ) : null}
            </DialogPanel>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
