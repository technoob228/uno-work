/**
 * App Store: a storefront where one click installs an app on this computer —
 * recommended apps first (files, passwords, notes, AI, photos, VPN), shelves by
 * section, developer tools last; search, sections, filters and a page per app.
 * Opened from the App Store program on the desktop; the install itself then
 * shows up as a program tile that talks ("Installing…") until it runs.
 */
import type {
  UnoComputerAppCategory,
  UnoComputerAppSetting,
  UnoComputerAppTemplate,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CheckIcon,
  CpuIcon,
  HardDriveIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  SearchIcon,
  SparklesIcon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

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
import {
  ALL_TAB,
  applyStoreView,
  featuredTemplates,
  fitsMemory,
  INSTALLED_TAB,
  NO_FILTERS,
  shelves,
  signInLabel,
  type StoreFilters,
} from "./appStoreModel";
import { formatMemory } from "./computerFormat";
import { installAiLines, storeAiLine } from "../settings/appAiProviderModel";

/** The app's logo: the brand mark Uno serves, the catalog emoji if there is none (or it fails). */
export function AppIcon({
  icon,
  iconUrl = null,
  className,
}: {
  icon: string | null;
  iconUrl?: string | null | undefined;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (iconUrl && !broken) {
    return (
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-black/5 dark:ring-white/10",
          className,
        )}
        aria-hidden
      >
        <img
          src={iconUrl}
          alt=""
          className="size-full object-contain"
          draggable={false}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      </span>
    );
  }
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

function Tag({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "good" | "uno" | "warn";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4",
        tone === "good" && "bg-success/10 text-success-foreground",
        tone === "uno" && "bg-primary/10 text-primary",
        tone === "muted" && "bg-muted text-muted-foreground",
        tone === "warn" && "bg-warning/15 text-warning-foreground",
      )}
    >
      {children}
    </span>
  );
}

function AppTags({
  template,
  installed,
  fits = null,
}: {
  template: UnoComputerAppTemplate;
  installed: boolean;
  /** false — this computer has less memory than the app asks for. */
  fits?: boolean | null;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {installed ? (
        <Tag tone="good">
          <CheckIcon className="size-3" /> Installed
        </Tag>
      ) : null}
      {template.madeByUno ? (
        <Tag tone="uno">
          <SparklesIcon className="size-3" /> Made by Uno
        </Tag>
      ) : null}
      {template.sso === "oidc" ? (
        <Tag tone="uno">
          <KeyRoundIcon className="size-3" /> Sign in with Uno
        </Tag>
      ) : null}
      {template.ai ? (
        <span title={storeAiLine(template.ai)} data-testid={`store-ai-${template.id}`}>
          <Tag tone="uno">
            <WandSparklesIcon className="size-3" /> Uses AI
          </Tag>
        </span>
      ) : null}
      {template.minRamMb > 0 ? (
        fits === false ? (
          <Tag tone="warn">Needs {formatMemory(template.minRamMb)} memory</Tag>
        ) : (
          <Tag>{formatMemory(template.minRamMb)} memory</Tag>
        )
      ) : null}
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border/70 text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function AppCatalogDialog({
  open,
  onOpenChange,
  templates,
  categories = [],
  installedTemplateIds,
  memTotalMb = null,
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
  /** Store sections in tab order (empty with an older console). */
  categories?: ReadonlyArray<UnoComputerAppCategory>;
  installedTemplateIds: ReadonlySet<string>;
  /** This computer's memory, for "Fits this computer" (null — unknown). */
  memTotalMb?: number | null;
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
  const [viewing, setViewing] = useState<UnoComputerAppTemplate | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [lastSettings, setLastSettings] = useState<Record<string, string> | undefined>(undefined);
  const [tab, setTab] = useState<string>(ALL_TAB);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<StoreFilters>(NO_FILTERS);

  const begin = (template: UnoComputerAppTemplate) => {
    // An app that uses AI always gets a confirm step that says so.
    if (template.settings.length === 0 && !template.ai) {
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

  const installedCount = templates.filter((t) => installedTemplateIds.has(t.id)).length;
  const hasSso = templates.some((t) => t.sso);
  const browsing =
    tab === ALL_TAB && query.trim().length === 0 && !filters.signInWithUno && !filters.fitsComputer;
  const results = useMemo(
    () =>
      applyStoreView({
        templates,
        tab,
        query,
        filters,
        installed: installedTemplateIds,
        memTotalMb,
      }),
    [templates, tab, query, filters, installedTemplateIds, memTotalMb],
  );
  const featured = useMemo(() => featuredTemplates(templates, categories), [templates, categories]);
  const shelfList = useMemo(() => shelves(templates, categories), [templates, categories]);
  const resetView = () => {
    setTab(ALL_TAB);
    setQuery("");
    setFilters(NO_FILTERS);
  };

  const installButton = (template: UnoComputerAppTemplate, size: "sm" | "default" = "sm") => {
    const already = installedTemplateIds.has(template.id);
    return (
      <Button
        size={size}
        variant={already ? "outline" : "default"}
        disabled={starting !== null || !computerOn}
        onClick={(event) => {
          event.stopPropagation();
          begin(template);
        }}
      >
        {starting === template.id ? <Spinner className="size-3.5" /> : null}
        {already ? "Install another" : "Install"}
      </Button>
    );
  };

  const featuredCard = (template: UnoComputerAppTemplate) => (
    <li key={template.id}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setViewing(template)}
        onKeyDown={(event) => {
          if (event.key === "Enter") setViewing(template);
        }}
        className="flex h-full cursor-pointer flex-col gap-3 rounded-2xl border border-border/60 bg-card/60 p-4 text-left transition-colors hover:border-border hover:bg-muted/30"
      >
        <div className="flex items-start gap-3">
          <AppIcon
            icon={template.icon}
            iconUrl={template.iconUrl}
            className="size-12 rounded-2xl text-2xl"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{template.name}</div>
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {template.tagline || template.description}
            </p>
          </div>
        </div>
        <div className="mt-auto flex items-end justify-between gap-2">
          <AppTags
            template={template}
            installed={installedTemplateIds.has(template.id)}
            fits={memTotalMb === null ? null : fitsMemory(template, memTotalMb)}
          />
          {installButton(template)}
        </div>
      </div>
    </li>
  );

  const appRow = (template: UnoComputerAppTemplate) => (
    <li key={template.id}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setViewing(template)}
        onKeyDown={(event) => {
          if (event.key === "Enter") setViewing(template);
        }}
        className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-muted/40"
      >
        <AppIcon icon={template.icon} iconUrl={template.iconUrl} className="size-10 text-xl" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{template.name}</span>
            {installedTemplateIds.has(template.id) ? (
              <CheckIcon className="size-3.5 shrink-0 text-success" aria-label="Installed" />
            ) : null}
            {template.madeByUno ? (
              <SparklesIcon className="size-3.5 shrink-0 text-primary" aria-label="Made by Uno" />
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {template.tagline || template.description}
          </p>
          {template.ai ? (
            <p
              className="truncate text-[11px] text-primary"
              data-testid={`store-ai-line-${template.id}`}
            >
              {storeAiLine(template.ai)}
            </p>
          ) : null}
        </div>
        {installButton(template)}
      </div>
    </li>
  );

  const detail = viewing ? (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-4">
        <AppIcon
          icon={viewing.icon}
          iconUrl={viewing.iconUrl}
          className="size-16 rounded-2xl p-2 text-3xl"
        />
        <div className="min-w-0 flex-1">
          {viewing.tagline ? (
            <p className="text-sm text-muted-foreground">{viewing.tagline}</p>
          ) : null}
          <div className="mt-2">
            <AppTags
              template={viewing}
              installed={installedTemplateIds.has(viewing.id)}
              fits={memTotalMb === null ? null : fitsMemory(viewing, memTotalMb)}
            />
          </div>
        </div>
      </div>
      <p className="text-sm leading-relaxed">{viewing.description}</p>
      <ul className="flex flex-col gap-2.5 rounded-xl bg-muted/40 p-3 text-xs leading-relaxed">
        {viewing.minRamMb > 0 ? (
          <li className="flex gap-2">
            <CpuIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span>
              Needs {formatMemory(viewing.minRamMb)} of memory
              {memTotalMb !== null
                ? fitsMemory(viewing, memTotalMb)
                  ? ` — this computer has ${formatMemory(memTotalMb)}, it fits.`
                  : ` — this computer has ${formatMemory(memTotalMb)}. It may be slow; add memory first.`
                : "."}
            </span>
          </li>
        ) : null}
        {viewing.minDiskGb > 0 ? (
          <li className="flex gap-2">
            <HardDriveIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span>Takes about {viewing.minDiskGb} GB of disk, plus what you put in it.</span>
          </li>
        ) : null}
        <li className="flex gap-2">
          <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span>
            {signInLabel(viewing) ??
              "Has its own sign-in. Uno creates your account and shows the password after install."}
          </span>
        </li>
        {viewing.ai ? (
          <li className="flex gap-2" data-testid="store-detail-ai">
            <WandSparklesIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <span>
              {storeAiLine(viewing.ai)} (starts over on the 1st). You can switch it to AI on this
              computer or your own key, change the limit or turn it off in Settings → Apps.
            </span>
          </li>
        ) : null}
        <li className="flex gap-2">
          <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span>
            {viewing.madeByUno
              ? "Made by Uno."
              : "An open-source app. Uno installs it on your computer — your data stays there."}
          </span>
        </li>
      </ul>
      {viewing.notes ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{viewing.notes}</p>
      ) : null}
    </div>
  ) : null;

  const browse = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2.5">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search apps — try “photos”, “passwords” or “Google Drive”"
            className="ps-8"
            aria-label="Search apps"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted"
              aria-label="Clear search"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Sections">
          <Chip active={tab === ALL_TAB} onClick={() => setTab(ALL_TAB)}>
            All
          </Chip>
          {categories
            .filter((c) => templates.some((t) => t.category === c.id))
            .map((c) => (
              <Chip key={c.id} active={tab === c.id} onClick={() => setTab(c.id)}>
                {c.name}
              </Chip>
            ))}
          {installedCount > 0 ? (
            <Chip active={tab === INSTALLED_TAB} onClick={() => setTab(INSTALLED_TAB)}>
              Installed · {installedCount}
            </Chip>
          ) : null}
        </div>
        {hasSso || memTotalMb !== null ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="me-0.5">Show only:</span>
            {hasSso ? (
              <Chip
                active={filters.signInWithUno}
                onClick={() => setFilters((f) => ({ ...f, signInWithUno: !f.signInWithUno }))}
              >
                <KeyRoundIcon className="size-3" /> Opens with Uno account
              </Chip>
            ) : null}
            {memTotalMb !== null ? (
              <Chip
                active={filters.fitsComputer}
                onClick={() => setFilters((f) => ({ ...f, fitsComputer: !f.fitsComputer }))}
              >
                <CpuIcon className="size-3" /> Fits this computer ({formatMemory(memTotalMb)})
              </Chip>
            ) : null}
          </div>
        ) : null}
      </div>

      {browsing ? (
        <>
          {featured.length > 0 ? (
            <section className="flex flex-col gap-2.5">
              <h3 className="text-sm font-semibold">Recommended</h3>
              <ul className="grid gap-3 sm:grid-cols-2">{featured.map(featuredCard)}</ul>
            </section>
          ) : null}
          {shelfList.map((shelf) => (
            <section key={shelf.id} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">{shelf.name}</h3>
                {shelf.id !== "_more" ? (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setTab(shelf.id)}
                  >
                    See all
                  </button>
                ) : null}
              </div>
              {shelf.technical ? (
                <p className="text-xs text-muted-foreground">
                  Tools for people who build and run things.
                </p>
              ) : null}
              <ul className="grid gap-x-3 sm:grid-cols-2">{shelf.apps.map(appRow)}</ul>
            </section>
          ))}
        </>
      ) : results.length > 0 ? (
        <ul className="grid gap-x-3 sm:grid-cols-2">{results.map(appRow)}</ul>
      ) : (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
          <p>
            {tab === INSTALLED_TAB && query.trim() === ""
              ? "Nothing installed from the App Store yet."
              : "No apps match."}
          </p>
          <Button size="sm" variant="outline" onClick={resetView}>
            Show all apps
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setConfiguring(null);
          setViewing(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          {viewing && !configuring ? (
            <button
              type="button"
              onClick={() => setViewing(null)}
              className="-ms-1 mb-1 inline-flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ArrowLeftIcon className="size-3.5" /> App Store
            </button>
          ) : null}
          <DialogTitle>
            {configuring
              ? configuring.settings.length === 0
                ? `Install ${configuring.name}?`
                : `Set up ${configuring.name}`
              : viewing
                ? viewing.name
                : "App Store"}
          </DialogTitle>
          <DialogDescription className={viewing && !configuring ? "sr-only" : undefined}>
            {configuring
              ? configuring.settings.length === 0
                ? "Before it installs, here is what it will use."
                : "A couple of details before it installs. These settings apply when the app is installed."
              : "Apps for your computer. Pick one and it installs by itself, keeps running and gets its own address."}
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
              {configuring.ai ? (
                <div
                  className="flex gap-2.5 rounded-xl bg-primary/5 px-3 py-2.5 text-xs leading-relaxed ring-1 ring-primary/15"
                  data-testid="install-ai-notice"
                >
                  <WandSparklesIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <ul className="flex flex-col gap-1">
                    {installAiLines(configuring.ai).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
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
          ) : viewing ? (
            detail
          ) : (
            browse
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
        {viewing && !configuring ? (
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewing(null)}>
              Back
            </Button>
            {installButton(viewing, "default")}
          </DialogFooter>
        ) : null}
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
