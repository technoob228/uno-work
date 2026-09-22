/**
 * App Store: a small catalog where one click installs an app on this computer.
 * Opened from the App Store program on the desktop; the install itself then
 * shows up as a program tile that talks ("Installing…") until it runs.
 */
import type { UnoComputerAppSetting, UnoComputerAppTemplate } from "@t3tools/contracts";
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
  confirm = null,
  onCancelConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: ReadonlyArray<UnoComputerAppTemplate>;
  installedTemplateIds: ReadonlySet<string>;
  starting: string | null;
  error: string | null;
  computerOn: boolean;
  onInstall: (
    template: UnoComputerAppTemplate,
    settings?: Record<string, string>,
    options?: { allowLowMemory?: boolean },
  ) => void;
  /** Uno asked to confirm before installing (the app wants more memory). */
  confirm?: { templateId: string; message: string } | null;
  onCancelConfirm?: () => void;
}) {
  const [configuring, setConfiguring] = useState<UnoComputerAppTemplate | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [lastSettings, setLastSettings] = useState<Record<string, string> | undefined>(undefined);

  const begin = (template: UnoComputerAppTemplate) => {
    if (template.settings.length === 0) {
      setLastSettings(undefined);
      onInstall(template);
      return;
    }
    setValues(Object.fromEntries(template.settings.map((s) => [s.name, s.defaultValue ?? ""])));
    setConfiguring(template);
  };
  const visible = (setting: UnoComputerAppSetting) =>
    !setting.showIf || (values[setting.showIf.name] ?? "") === setting.showIf.value;
  const missing = configuring
    ? configuring.settings.filter(
        (s) => s.required && visible(s) && (values[s.name] ?? "").trim().length === 0,
      )
    : [];
  const confirmTemplate = confirm
    ? (templates.find((t) => t.id === confirm.templateId) ?? null)
    : null;

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
                if (missing.length > 0) return;
                // Only fields that apply to the current choice travel; the
                // console drops the rest anyway, but it keeps the S3 keys out
                // of an install that stores files on the disk.
                const filled = Object.fromEntries(
                  configuring.settings
                    .filter((s) => visible(s))
                    .map((s) => [s.name, values[s.name] ?? ""] as const)
                    .filter(([, v]) => v.trim().length > 0),
                );
                setLastSettings(filled);
                onInstall(configuring, filled);
              }}
            >
              {configuring.settings.filter(visible).map((setting) =>
                setting.options && setting.options.length > 0 ? (
                  <fieldset key={setting.name} className="flex flex-col gap-1.5 text-sm">
                    <legend className="mb-1.5 font-medium">
                      {setting.description || setting.name}
                    </legend>
                    <div role="radiogroup" className="flex flex-col gap-1.5">
                      {setting.options.map((option) => {
                        const checked = (values[setting.name] ?? "") === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            onClick={() =>
                              setValues((prev) => ({ ...prev, [setting.name]: option.value }))
                            }
                            className={cn(
                              "flex items-center gap-2.5 rounded-xl border px-3 py-2 text-left text-sm transition-colors",
                              checked
                                ? "border-primary bg-primary/5"
                                : "border-border/60 hover:bg-muted/40",
                            )}
                          >
                            <span
                              className={cn(
                                "flex size-4 shrink-0 items-center justify-center rounded-full border",
                                checked ? "border-primary" : "border-muted-foreground/40",
                              )}
                              aria-hidden
                            >
                              {checked ? <span className="size-2 rounded-full bg-primary" /> : null}
                            </span>
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                ) : (
                  <label key={setting.name} className="flex flex-col gap-1.5 text-sm">
                    <span className="font-medium">
                      {setting.description || setting.name}
                      {setting.required ? (
                        <span className="text-muted-foreground" aria-hidden>
                          {" "}
                          *
                        </span>
                      ) : null}
                    </span>
                    <Input
                      type={setting.secret ? "password" : "text"}
                      value={values[setting.name] ?? ""}
                      required={setting.required === true}
                      onChange={(event) =>
                        setValues((prev) => ({ ...prev, [setting.name]: event.target.value }))
                      }
                      autoComplete="off"
                    />
                  </label>
                ),
              )}
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
          {confirm && confirmTemplate ? (
            <div
              className="mt-4 flex flex-col gap-3 rounded-xl bg-warning/10 px-3 py-3 text-xs leading-relaxed"
              role="alertdialog"
              aria-label="Not enough memory"
            >
              <p>{confirm.message}</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={starting !== null}
                  onClick={() => onInstall(confirmTemplate, lastSettings, { allowLowMemory: true })}
                >
                  {starting ? <Spinner className="size-3.5" /> : null}
                  Install anyway
                </Button>
                <Button size="sm" variant="outline" onClick={() => onCancelConfirm?.()}>
                  Cancel
                </Button>
              </div>
            </div>
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
            <Button
              type="submit"
              form="app-settings-form"
              disabled={starting !== null || missing.length > 0}
            >
              {starting ? <Spinner className="size-3.5" /> : null}
              Install {configuring.name}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
