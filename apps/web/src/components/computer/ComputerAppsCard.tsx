/**
 * Apps: what is installed on this computer, and "Add app" — a small catalog
 * where one click installs an app and the card shows it arriving: progress in
 * plain lines, then "Running" with the address it answers at.
 */
import type {
  UnoComputerApps,
  UnoComputerAppTemplate,
  UnoComputerInstalledApp,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  ExternalLinkIcon,
  LayoutGridIcon,
  PlusIcon,
  XCircleIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { displayAddress, formatMemory } from "./computerFormat";
import { QuietState, SectionCard } from "./computerUi";
import type { AppInstall } from "./useAppInstalls";

function AppIcon({ icon, className }: { icon: string | null; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-lg",
        className,
      )}
      aria-hidden
    >
      {icon || <LayoutGridIcon className="size-4 text-muted-foreground" />}
    </span>
  );
}

const STATE_WORD: Record<UnoComputerInstalledApp["state"], string> = {
  running: "Running",
  installing: "Installing…",
  failed: "Didn't start",
  unknown: "—",
};

function OpenLink({ url }: { url: string }) {
  return (
    <Button
      size="xs"
      variant="outline"
      render={<a href={url} target="_blank" rel="noopener noreferrer" />}
    >
      <ExternalLinkIcon />
      Open
    </Button>
  );
}

function InstallRow({
  install,
  computerOn,
  onDismiss,
}: {
  install: AppInstall;
  computerOn: boolean;
  onDismiss: () => void;
}) {
  const last = install.lines[install.lines.length - 1];
  // A finished app sleeps with its computer: no "Running", no Open.
  const asleep = install.state === "running" && !computerOn;
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border/60 bg-background/60 p-3">
      <div className="flex items-center gap-3">
        <AppIcon icon={install.icon} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{install.name}</div>
          <div
            className={cn(
              "flex items-center gap-1.5 text-[11px]",
              install.state === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {install.state === "installing" ? (
              <Spinner className="size-3" />
            ) : asleep ? null : install.state === "running" ? (
              <CheckCircle2Icon className="size-3 text-success" />
            ) : (
              <XCircleIcon className="size-3" />
            )}
            {install.state === "installing"
              ? "Installing…"
              : asleep
                ? "Asleep with the computer"
                : install.state === "running"
                  ? "Running"
                  : "The install didn't finish"}
          </div>
        </div>
        {install.state === "running" && install.url && !asleep ? (
          <OpenLink url={install.url} />
        ) : null}
        {install.state !== "installing" ? (
          <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
            <XIcon />
          </Button>
        ) : null}
      </div>
      {install.state === "running" && install.url ? (
        <div className="truncate pl-12 font-mono text-[11px] text-muted-foreground">
          {displayAddress(install.url)}
        </div>
      ) : last ? (
        <div className="truncate pl-12 font-mono text-[11px] text-muted-foreground" title={last}>
          {last}
        </div>
      ) : null}
    </li>
  );
}

export function ComputerAppsCard({
  apps,
  loading,
  installs,
  starting,
  startError,
  computerOn,
  onInstall,
  onDismissInstall,
  onClearStartError,
}: {
  apps: UnoComputerApps | undefined;
  loading: boolean;
  installs: ReadonlyArray<AppInstall>;
  starting: string | null;
  startError: string | null;
  computerOn: boolean;
  onInstall: (
    template: UnoComputerAppTemplate,
    settings?: Record<string, string>,
  ) => Promise<boolean>;
  onDismissInstall: (deploymentId: number) => void;
  onClearStartError: () => void;
}) {
  const [storeOpen, setStoreOpen] = useState(false);
  const catalog = apps?.catalog;
  const catalogReady = catalog?.availability === "ok" && catalog.templates.length > 0;

  // Apps shown as a live install card are not repeated in the list below.
  const tracked = useMemo(() => new Set(installs.map((i) => i.deploymentId)), [installs]);
  const installed = (apps?.installed.apps ?? []).filter(
    (app) => app.deploymentId === null || !tracked.has(app.deploymentId),
  );

  return (
    <SectionCard
      title="Apps"
      icon={<LayoutGridIcon />}
      action={
        catalogReady ? (
          <Button size="xs" variant="outline" onClick={() => setStoreOpen(true)}>
            <PlusIcon />
            Add app
          </Button>
        ) : null
      }
    >
      {loading && !apps ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {installs.length > 0 || installed.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {installs.map((install) => (
                <InstallRow
                  key={`install:${install.deploymentId}`}
                  install={install}
                  computerOn={computerOn}
                  onDismiss={() => onDismissInstall(install.deploymentId)}
                />
              ))}
              {installed.map((app) => (
                <li
                  key={app.key}
                  className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/60 p-3"
                >
                  <AppIcon icon={app.icon} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{app.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {computerOn ? STATE_WORD[app.state] : "Asleep with the computer"}
                      {app.url ? ` · ${displayAddress(app.url)}` : ""}
                    </div>
                  </div>
                  {app.url && computerOn && app.state === "running" ? (
                    <OpenLink url={app.url} />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : apps?.installed.availability === "ok" ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Nothing installed yet. Apps are programs that keep running on your computer — a
              website, a bot, a dashboard — each with its own address.
            </p>
          ) : null}

          {catalog && catalog.availability !== "ok" ? (
            <QuietState
              availability={catalog.availability}
              message={catalog.message}
              soon="One-click apps — uptime monitoring, a blog, automations, a file browser — are almost here."
              offline="Wake your computer up to add apps."
            />
          ) : catalogReady && installs.length === 0 && installed.length === 0 ? (
            <Button className="self-start" size="sm" onClick={() => setStoreOpen(true)}>
              <PlusIcon />
              Add your first app
            </Button>
          ) : null}
        </div>
      )}

      <AppCatalogDialog
        open={storeOpen}
        onOpenChange={(open) => {
          setStoreOpen(open);
          if (!open) onClearStartError();
        }}
        templates={catalog?.templates ?? []}
        installedTemplateIds={
          new Set(
            [...installs.map((i) => i.templateId), ...installed.map((a) => a.templateId)].filter(
              (id): id is string => id !== null,
            ),
          )
        }
        starting={starting}
        error={startError}
        computerOn={computerOn}
        onInstall={async (template, settings) => {
          if (await onInstall(template, settings)) setStoreOpen(false);
        }}
      />
    </SectionCard>
  );
}

function AppCatalogDialog({
  open,
  onOpenChange,
  templates,
  installedTemplateIds,
  starting,
  error,
  computerOn,
  onInstall,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: ReadonlyArray<UnoComputerAppTemplate>;
  installedTemplateIds: ReadonlySet<string>;
  starting: string | null;
  error: string | null;
  computerOn: boolean;
  onInstall: (template: UnoComputerAppTemplate, settings?: Record<string, string>) => void;
}) {
  const [configuring, setConfiguring] = useState<UnoComputerAppTemplate | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  const begin = (template: UnoComputerAppTemplate) => {
    if (template.settings.length === 0) {
      onInstall(template);
      return;
    }
    setValues(Object.fromEntries(template.settings.map((s) => [s.name, s.defaultValue ?? ""])));
    setConfiguring(template);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setConfiguring(null);
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{configuring ? `Set up ${configuring.name}` : "Add an app"}</DialogTitle>
          <DialogDescription>
            {configuring
              ? "A couple of details before it installs. You can change them later."
              : "Pick an app and your computer installs it by itself. It keeps running and gets its own address."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {configuring ? (
            <form
              id="app-settings-form"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const filled = Object.fromEntries(
                  Object.entries(values).filter(([, v]) => v.trim().length > 0),
                );
                onInstall(configuring, filled);
              }}
            >
              {configuring.settings.map((setting) => (
                <label key={setting.name} className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium">{setting.description || setting.name}</span>
                  <Input
                    type={setting.secret ? "password" : "text"}
                    value={values[setting.name] ?? ""}
                    onChange={(event) =>
                      setValues((prev) => ({ ...prev, [setting.name]: event.target.value }))
                    }
                    autoComplete="off"
                  />
                </label>
              ))}
            </form>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {templates.map((template) => {
                const isStarting = starting === template.id;
                const already = installedTemplateIds.has(template.id);
                return (
                  <li
                    key={template.id}
                    className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card/40 p-4"
                  >
                    <div className="flex items-center gap-3">
                      <AppIcon icon={template.icon} className="size-10 text-xl" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{template.name}</div>
                        {template.minRamMb > 0 ? (
                          <div className="text-[11px] text-muted-foreground">
                            Needs {formatMemory(template.minRamMb)} of memory
                          </div>
                        ) : null}
                      </div>
                    </div>
                    <p className="line-clamp-3 flex-1 text-xs leading-relaxed text-muted-foreground">
                      {template.description}
                    </p>
                    <Button
                      size="sm"
                      variant={already ? "outline" : "default"}
                      disabled={starting !== null || !computerOn}
                      onClick={() => begin(template)}
                    >
                      {isStarting ? <Spinner className="size-3.5" /> : null}
                      {already ? "Install another" : "Install"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {!computerOn ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Your computer is asleep. Wake it up to install apps.
            </p>
          ) : null}
          {error ? (
            <p className="mt-4 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        {configuring ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfiguring(null)}>
              Back
            </Button>
            <Button type="submit" form="app-settings-form" disabled={starting !== null}>
              {starting ? <Spinner className="size-3.5" /> : null}
              Install {configuring.name}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
