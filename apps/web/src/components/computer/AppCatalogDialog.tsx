/**
 * App Store: a small catalog where one click installs an app on this computer.
 * Opened from the App Store program on the desktop; the install itself then
 * shows up as a program tile that talks ("Installing…") until it runs.
 */
import type { UnoComputerAppTemplate } from "@t3tools/contracts";
import { LayoutGridIcon } from "lucide-react";
import { useState } from "react";

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
import { Spinner } from "../ui/spinner";
import { formatMemory } from "./computerFormat";

export function AppIcon({ icon, className }: { icon: string | null; className?: string }) {
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

export function AppCatalogDialog({
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
