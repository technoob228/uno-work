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
  CopyIcon,
  CpuIcon,
  HardDriveIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  MemoryStickIcon,
  SearchIcon,
  SmartphoneIcon,
  SparklesIcon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode, type SVGProps } from "react";

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
  hasFilters,
  INSTALLED_TAB,
  logoSources,
  NO_FILTERS,
  phonePlatforms,
  shelves,
  signInLabel,
  storeHighlights,
  type StoreFilters,
  type StoreHighlight,
} from "./appStoreModel";
import { appDisplayName } from "./appTaskNames";
import { formatMemory } from "./computerFormat";
import { installAiLines, storeAiLine } from "../settings/appAiProviderModel";
import { OwnToolsRow } from "../setup/OwnToolsDialog";
import { useSetupTourStore } from "../setup/SetupTour";

/**
 * The app's logo: the brand mark Uno serves. A computer on an older Uno Work
 * doesn't pass the logo address on — then the console's logo by app id (svg,
 * then png); the catalog emoji if none loads.
 */
export function AppIcon({
  icon,
  iconUrl = null,
  templateId = null,
  className,
}: {
  icon: string | null;
  iconUrl?: string | null | undefined;
  /** The catalog id, for the logo fallback. */
  templateId?: string | null;
  className?: string;
}) {
  const sources = templateId ? logoSources({ id: templateId, iconUrl }) : iconUrl ? [iconUrl] : [];
  const key = sources.join(" ");
  // Which source failed last, per source list: a new list starts over.
  const [failed, setFailed] = useState<{ key: string; count: number }>({ key, count: 0 });
  const attempt = failed.key === key ? failed.count : 0;
  const src = sources[attempt];
  if (src) {
    return (
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-black/5 dark:ring-white/10",
          className,
        )}
        aria-hidden
      >
        <img
          key={src}
          src={src}
          alt=""
          className="size-full object-contain"
          draggable={false}
          loading="lazy"
          onError={() => setFailed({ key, count: attempt + 1 })}
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

/** Apple and Android marks (simple-icons paths, CC0) for "Phone apps". */
function AppleMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

function AndroidMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 0 0-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 0 0-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 0 0-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z" />
    </svg>
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

function highlightTag(h: StoreHighlight, template: UnoComputerAppTemplate) {
  switch (h.kind) {
    case "uno":
      return (
        <Tag key={h.kind} tone="uno">
          <SparklesIcon className="size-3" /> {h.label}
        </Tag>
      );
    case "sso":
      return (
        <Tag key={h.kind} tone="uno">
          <KeyRoundIcon className="size-3" /> {h.label}
        </Tag>
      );
    case "ai":
      return (
        <span
          key={h.kind}
          title={template.ai ? storeAiLine(template.ai) : undefined}
          data-testid={`store-ai-${template.id}`}
        >
          <Tag tone="uno">
            <WandSparklesIcon className="size-3" /> {h.label}
          </Tag>
        </span>
      );
    case "phone":
      return (
        <span
          key={h.kind}
          title={
            template.mobile
              ? `${template.mobile.appName ?? template.name} for ${phonePlatforms(template.mobile)} connects to it`
              : undefined
          }
          data-testid={`store-phone-${template.id}`}
        >
          <Tag>
            <SmartphoneIcon className="size-3" /> {h.label}
            {h.ios ? <AppleMark className="size-2.5" /> : null}
            {h.android ? <AndroidMark className="size-2.5" /> : null}
          </Tag>
        </span>
      );
    case "memory":
      return (
        <span
          key={h.kind}
          title={`Needs ${formatMemory(template.minRamMb)} of memory`}
          data-testid={`store-memory-${template.id}`}
        >
          <Tag tone={h.tight ? "warn" : "muted"}>
            <MemoryStickIcon className="size-3" /> {h.label}
          </Tag>
        </span>
      );
  }
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
      {storeHighlights(template, fits, formatMemory).map((h) => highlightTag(h, template))}
    </div>
  );
}

/** Small icons only (a row in a shelf): what the app is like, with the words on hover. */
function RowHighlights({ template }: { template: UnoComputerAppTemplate }) {
  const icons = storeHighlights(template, null, formatMemory).filter((h) => h.kind !== "memory");
  if (icons.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
      {icons.map((h) => {
        const cls = cn("size-3.5", h.kind !== "phone" && "text-primary");
        const icon =
          h.kind === "uno" ? (
            <SparklesIcon className={cls} />
          ) : h.kind === "sso" ? (
            <KeyRoundIcon className={cls} />
          ) : h.kind === "ai" ? (
            <WandSparklesIcon className={cls} />
          ) : (
            <SmartphoneIcon className={cls} />
          );
        return (
          <span key={h.kind} title={h.label} aria-label={h.label} role="img">
            {icon}
          </span>
        );
      })}
    </span>
  );
}

function StoreButton({ href, label, mark }: { href: string; label: string; mark: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-muted/60"
    >
      {mark}
      {label}
    </a>
  );
}

function PhoneBlock({
  template,
  address,
}: {
  template: UnoComputerAppTemplate;
  /** The installed app's address; null — not installed yet. */
  address: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const mobile = template.mobile;
  if (!mobile) return null;
  const appName = mobile.appName ?? template.name;
  return (
    <section
      className="flex flex-col gap-2.5 rounded-xl border border-border/60 p-3"
      data-testid="store-detail-phone"
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        <SmartphoneIcon className="size-4 text-muted-foreground" /> Use it on your phone
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Download {appName} for {phonePlatforms(mobile)}.{" "}
        {mobile.note ?? "Then sign in with your address."}
      </p>
      <div className="flex flex-wrap gap-2">
        {mobile.ios ? (
          <StoreButton
            href={mobile.ios}
            label="App Store"
            mark={<AppleMark className="size-3.5" />}
          />
        ) : null}
        {mobile.android ? (
          <StoreButton
            href={mobile.android}
            label="Google Play"
            mark={<AndroidMark className="size-3.5" />}
          />
        ) : null}
      </div>
      {address ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5">
          <span className="text-xs text-muted-foreground">Your address</span>
          <code className="min-w-0 flex-1 truncate text-xs" data-testid="store-phone-address">
            {address}
          </code>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Copy address"
            onClick={() => {
              void navigator.clipboard?.writeText(address).then(() => setCopied(true));
            }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Your address appears here and on the app card once it is installed.
        </p>
      )}
    </section>
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

/** A Made by Uno app that ships inside Uno Work (opens a screen, no install). */
export interface StoreBuiltInApp {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly icon: ReactNode;
  readonly onOpen: () => void;
}

/** An app's task name ("Files & documents") with its product name small beside it ("Nextcloud"). */
function AppName({
  template,
  className,
}: {
  template: Pick<UnoComputerAppTemplate, "id" | "name">;
  className?: string;
}) {
  const shown = appDisplayName(template.id, template.name);
  return (
    <span className={cn("flex min-w-0 items-baseline gap-1.5", className)}>
      <span className="truncate">{shown.title}</span>
      {shown.product ? (
        <span
          className="shrink-0 truncate text-[11px] font-normal text-muted-foreground"
          data-testid="store-product-name"
        >
          {shown.product}
        </span>
      ) : null}
    </span>
  );
}

/** One plain line on what the app gives you: the catalog's, else ours, else its description. */
function appLine(template: UnoComputerAppTemplate): string {
  return (
    template.tagline || appDisplayName(template.id, template.name).line || template.description
  );
}

/** The task name alone, for titles and buttons ("Install Passwords?"). */
function taskName(template: Pick<UnoComputerAppTemplate, "id" | "name">): string {
  return appDisplayName(template.id, template.name).title;
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
  appAddresses = new Map(),
  builtInApps = [],
}: {
  /** Made by Uno apps built into Uno Work (nothing to install): shown first. */
  builtInApps?: ReadonlyArray<StoreBuiltInApp>;
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
  /** Installed apps' addresses by catalog id, for "Use it on your phone". */
  appAddresses?: ReadonlyMap<string, string>;
}) {
  const touringStore = useSetupTourStore((state) => state.step === "apps");
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
  const hasPhoneApps = templates.some((t) => t.mobile);
  const browsing = tab === ALL_TAB && query.trim().length === 0 && !hasFilters(filters);
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
            templateId={template.id}
            className="size-12 rounded-2xl text-2xl"
          />
          <div className="min-w-0 flex-1">
            <AppName template={template} className="text-sm font-semibold" />
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {appLine(template)}
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
        <AppIcon
          icon={template.icon}
          iconUrl={template.iconUrl}
          templateId={template.id}
          className="size-10 text-xl"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <AppName template={template} className="text-sm font-medium" />
            {installedTemplateIds.has(template.id) ? (
              <CheckIcon className="size-3.5 shrink-0 text-success" aria-label="Installed" />
            ) : null}
            <RowHighlights template={template} />
          </div>
          <p className="truncate text-xs text-muted-foreground">{appLine(template)}</p>
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

  const viewingName = viewing ? appDisplayName(viewing.id, viewing.name) : null;
  const detail = viewing ? (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-4">
        <AppIcon
          icon={viewing.icon}
          iconUrl={viewing.iconUrl}
          templateId={viewing.id}
          className="size-16 rounded-2xl p-2 text-3xl"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">
            {[viewingName?.product, viewing.tagline || viewingName?.line]
              .filter(Boolean)
              .join(" · ")}
          </p>
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
      <PhoneBlock template={viewing} address={appAddresses.get(viewing.id) ?? null} />
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
        {hasSso || hasPhoneApps || memTotalMb !== null ? (
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
            {hasPhoneApps ? (
              <Chip
                active={filters.phoneApps}
                onClick={() => setFilters((f) => ({ ...f, phoneApps: !f.phoneApps }))}
              >
                <SmartphoneIcon className="size-3" /> Phone apps
              </Chip>
            ) : null}
          </div>
        ) : null}
      </div>

      {browsing ? (
        <>
          {builtInApps.length > 0 ? (
            <section className="flex flex-col gap-2.5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <SparklesIcon className="size-3.5 text-primary" /> Made by Uno
              </h3>
              <ul className="grid gap-3 sm:grid-cols-2">
                {builtInApps.map((app) => (
                  <li key={app.id}>
                    <div className="flex h-full flex-col gap-3 rounded-2xl border border-border/60 bg-card/60 p-4">
                      <div className="flex items-start gap-3">
                        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl">
                          {app.icon}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold">{app.name}</div>
                          <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                            {app.tagline}
                          </p>
                        </div>
                      </div>
                      <div className="mt-auto flex items-end justify-between gap-2">
                        <span className="text-xs text-muted-foreground">Built in · free</span>
                        <Button
                          size="sm"
                          onClick={() => {
                            onOpenChange(false);
                            app.onOpen();
                          }}
                        >
                          Open
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
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
      // The setup tour points at the App Store with its own card: the card
      // must stay clickable, so the store isn't modal while the tour is on it.
      modal={touringStore ? false : true}
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
                ? `Install ${taskName(configuring)}?`
                : `Set up ${taskName(configuring)}`
              : viewing
                ? taskName(viewing)
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
            <>
              {browse}
              <OwnToolsRow title="Don’t want to install an app, or yours isn’t here?" />
            </>
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
              Install {taskName(configuring)}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
