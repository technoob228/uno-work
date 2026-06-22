import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import {
  EyeIcon,
  ImagePlusIcon,
  type LucideIcon,
  RadioIcon,
  StarIcon,
  WrenchIcon,
} from "lucide-react";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";
import {
  modelCannotRunCodingAgent,
  modelSupportsImageInput,
  modelSupportsImageOutput,
  modelSupportsTools,
} from "./modelCapabilities";
import { ComboboxItem } from "../ui/combobox";
import { Kbd } from "../ui/kbd";
import { cn } from "~/lib/utils";

type ModelCapabilityTone = "tools" | "imageInput" | "imageOutput" | "streaming";

const CAPABILITY_TONE_CLASS: Record<ModelCapabilityTone, string> = {
  tools:
    "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:border-sky-400/25 dark:bg-sky-400/10 dark:text-sky-300",
  imageInput:
    "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:border-violet-400/25 dark:bg-violet-400/10 dark:text-violet-300",
  imageOutput:
    "border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:border-fuchsia-400/25 dark:bg-fuchsia-400/10 dark:text-fuchsia-300",
  streaming:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-300",
};

function ModelCapabilityIcon(props: {
  label: string;
  tooltip: string;
  icon: LucideIcon;
  tone: ModelCapabilityTone;
}) {
  const Icon = props.icon;
  return (
    <span
      className={cn(
        "inline-flex size-5 items-center justify-center rounded border transition-colors group-data-selected:bg-background group-data-highlighted:bg-background",
        CAPABILITY_TONE_CLASS[props.tone],
      )}
      aria-label={props.label}
      title={props.tooltip}
    >
      <Icon className="size-3" aria-hidden="true" />
    </span>
  );
}

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  isFavorite: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  jumpLabel?: string | null;
  disabled?: boolean;
  disabledReason?: string | null;
  onToggleFavorite: () => void;
}) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const providerLabel =
    props.model.subProvider && props.model.subProvider !== props.providerDisplayName
      ? `${props.providerDisplayName} · ${props.model.subProvider}`
      : props.providerDisplayName;
  const metadata = props.model.capabilities?.metadata;
  const tierLabel =
    metadata?.tier === "frontier"
      ? "Frontier"
      : metadata?.tier === "strong"
        ? "Strong"
        : metadata?.tier === "cheap"
          ? "Average"
          : null;
  const tierClassName =
    metadata?.tier === "frontier"
      ? "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:border-violet-400/25 dark:bg-violet-400/10 dark:text-violet-300"
      : metadata?.tier === "strong"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-300"
        : metadata?.tier === "cheap"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-300"
          : "border-border/70";
  const routeLabel =
    metadata?.defaultRoute === "russia"
      ? "Russia"
      : metadata?.defaultRoute === "default"
        ? "Global"
        : null;
  const estimatedCost = metadata?.pricing?.estimatedSeriousTaskUsd;
  const supportsTools = modelSupportsTools(props.model.capabilities);
  const supportsImageInput = modelSupportsImageInput(props.model.capabilities);
  const supportsImageOutput = modelSupportsImageOutput(props.model.capabilities);
  const supportsStreaming = metadata?.supports?.streaming === true;
  const hasCapabilityIcons =
    supportsTools || supportsImageInput || supportsImageOutput || supportsStreaming;
  const disabledReason =
    props.disabledReason ??
    (props.driverKind === "uno" && modelCannotRunCodingAgent(props.model.capabilities)
      ? "This model cannot run coding-agent turns because it does not support tools."
      : null);
  const disabled = props.disabled === true || disabledReason !== null;

  return (
    <ComboboxItem
      disabled={disabled}
      hideIndicator
      index={props.index}
      value={`${props.instanceId}:${props.model.slug}`}
      contentClassName="flex w-full items-start gap-2"
      title={disabledReason ?? undefined}
      className={cn(
        "w-full cursor-pointer rounded px-3 py-2 transition-colors group",
        "data-highlighted:bg-muted data-selected:bg-accent data-selected:text-foreground",
        disabled && "cursor-not-allowed opacity-55",
      )}
    >
      <button
        className="mt-0.5 shrink-0 cursor-pointer opacity-40 transition-opacity group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          props.onToggleFavorite();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
        }}
        type="button"
        aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
        title={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
      >
        <StarIcon className={cn("size-4", props.isFavorite && "fill-current text-yellow-500")} />
      </button>

      <div className="min-w-0 flex-1 text-left">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="text-xs font-medium leading-snug flex items-center gap-2 min-w-0">
            <span className="truncate">
              {props.useTriggerLabel
                ? getTriggerDisplayModelLabel(props.model)
                : getDisplayModelName(
                    props.model,
                    props.preferShortName ? { preferShortName: true } : undefined,
                  )}
            </span>
            {props.showNewBadge ? (
              <span
                className="shrink-0 rounded border border-amber-500/35 bg-amber-500/15 px-0.5 py-px text-[10px] font-bold uppercase leading-none tracking-wide text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/12 dark:text-amber-200"
                aria-label="New model"
              >
                New
              </span>
            ) : null}
          </div>
          {props.jumpLabel ? (
            <Kbd className="h-4 min-w-0 shrink-0 rounded-sm px-1.5 text-[10px]">
              {props.jumpLabel}
            </Kbd>
          ) : null}
        </div>
        {props.showProvider && (
          <div className="flex items-center gap-1 mt-0.5">
            {ProviderIcon ? <ProviderIcon className="size-3 shrink-0" /> : null}
            {props.providerAccentColor ? (
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: props.providerAccentColor }}
                aria-hidden
              />
            ) : null}
            <span className="text-xs font-normal leading-snug text-muted-foreground/70 truncate">
              {providerLabel}
            </span>
          </div>
        )}
        {metadata ? (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-[10px] leading-none text-muted-foreground/75">
            {tierLabel ? (
              <span className={cn("rounded border px-1 py-0.5", tierClassName)}>{tierLabel}</span>
            ) : null}
            {routeLabel ? (
              <span className="rounded border border-border/70 px-1 py-0.5">{routeLabel}</span>
            ) : null}
            {typeof estimatedCost === "number" && Number.isFinite(estimatedCost) ? (
              <span className="rounded border border-border/70 px-1 py-0.5">
                ~${estimatedCost.toFixed(estimatedCost >= 10 ? 0 : 2)}/request
              </span>
            ) : null}
            {hasCapabilityIcons ? (
              <span className="inline-flex items-center gap-0.5">
                {supportsTools ? (
                  <ModelCapabilityIcon
                    icon={WrenchIcon}
                    label="Tools"
                    tooltip="This model can use tools."
                    tone="tools"
                  />
                ) : null}
                {supportsImageInput ? (
                  <ModelCapabilityIcon
                    icon={EyeIcon}
                    label="Image input"
                    tooltip="This model can read attached images."
                    tone="imageInput"
                  />
                ) : null}
                {supportsImageOutput ? (
                  <ModelCapabilityIcon
                    icon={ImagePlusIcon}
                    label="Image generation"
                    tooltip="This model can generate images."
                    tone="imageOutput"
                  />
                ) : null}
                {supportsStreaming ? (
                  <ModelCapabilityIcon
                    icon={RadioIcon}
                    label="Streaming"
                    tooltip="This model can stream responses."
                    tone="streaming"
                  />
                ) : null}
              </span>
            ) : null}
            {disabledReason ? (
              <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200">
                No tools
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </ComboboxItem>
  );
});
