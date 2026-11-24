import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import {
  CheckIcon,
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
} from "./providerIconUtils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
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
  /** The instance's configured name, for screen readers (the logo names it on screen). */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  providerIconText?: string | undefined;
  /** Marks this instance apart from another of the same provider. */
  showInstanceBadge?: boolean;
  isFavorite: boolean;
  /** In Favorites every row is starred, so the star shows only on hover. */
  favoriteStarOnHover?: boolean;
  isSelected: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  jumpLabel?: string | null;
  disabled?: boolean;
  disabledReason?: string | null;
  onToggleFavorite: () => void;
}) {
  const metadata = props.model.capabilities?.metadata;
  // Uno AI time: Smart / Fast and the premium models name the real model after theirs.
  const curated = metadata?.unoGroup === "included" || metadata?.unoGroup === "premium";
  // The full Uno gateway catalog keeps its tier, price and capability line under the name.
  const showCatalogLine = Boolean(metadata) && !curated;
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
  // Personal AI: платится время на личном GPU, а не токены.
  const perHourUsd = metadata?.pricing?.perHourUsd;
  const isPersonal = metadata?.personal !== undefined;
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
  const name = props.useTriggerLabel
    ? getTriggerDisplayModelLabel(props.model)
    : getDisplayModelName(
        props.model,
        props.preferShortName ? { preferShortName: true } : undefined,
      );
  const aside =
    curated && !props.useTriggerLabel ? metadata?.underlyingModel : props.model.subProvider;
  const title = disabledReason ?? (curated ? metadata?.description : undefined);

  // T3's row (upstream `ModelListRow.tsx` f99ef08b): logo, name, a check on the
  // selected model, the star on hover at the end.
  return (
    <ComboboxItem
      disabled={disabled}
      hideIndicator
      index={props.index}
      value={`${props.instanceId}:${props.model.slug}`}
      contentClassName="flex w-full min-w-0 items-center gap-2"
      title={title ?? undefined}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer px-2 py-1",
        "hover:bg-foreground/[0.09] data-highlighted:bg-foreground/[0.09] data-selected:bg-transparent [&[data-highlighted][data-selected]]:bg-foreground/[0.09]",
        disabled && "cursor-not-allowed opacity-55",
      )}
    >
      <ProviderInstanceIcon
        driverKind={props.driverKind}
        iconText={props.providerIconText}
        displayName={props.providerDisplayName}
        accentColor={props.providerAccentColor}
        showBadge={props.showInstanceBadge === true}
        className={cn("size-4", showCatalogLine && "self-start mt-0.5")}
        iconClassName="size-4"
        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
      />
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="min-w-0 truncate text-sm font-normal leading-snug"
            data-model-picker-model-name
            // Names the row in full on hover only when it is cut off (upstream).
            onPointerEnter={(event) => {
              const element = event.currentTarget;
              element.title = element.scrollWidth > element.clientWidth ? name : "";
            }}
          >
            {name}
            {/* The logo is decorative, so name the provider for screen readers. */}
            <span className="sr-only">, {props.providerDisplayName}</span>
          </div>
          {props.isSelected ? <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
          {aside ? (
            <span className="min-w-0 shrink truncate text-xs text-muted-foreground/70">
              {aside}
            </span>
          ) : null}
          {props.showNewBadge ? (
            <span
              className="shrink-0 rounded border border-amber-500/35 bg-amber-500/15 px-0.5 py-px text-[10px] font-bold uppercase leading-none tracking-wide text-amber-800 dark:border-amber-400/30 dark:bg-amber-400/12 dark:text-amber-200"
              aria-label="New model"
            >
              New
            </span>
          ) : null}
        </div>
        {showCatalogLine ? (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-[10px] leading-none text-muted-foreground/75">
            {tierLabel ? (
              <span className={cn("rounded border px-1 py-0.5", tierClassName)}>{tierLabel}</span>
            ) : null}
            {routeLabel ? (
              <span className="rounded border border-border/70 px-1 py-0.5">{routeLabel}</span>
            ) : null}
            {isPersonal ? (
              <span
                className="rounded border border-sky-500/30 bg-sky-500/10 px-1 py-0.5 text-sky-700 dark:border-sky-400/25 dark:bg-sky-400/10 dark:text-sky-300"
                title="Runs on your own private GPU. Start it once, then chat as usual."
              >
                Private GPU
              </span>
            ) : null}
            {typeof perHourUsd === "number" && Number.isFinite(perHourUsd) ? (
              <span
                className="rounded border border-border/70 px-1 py-0.5"
                title="Billed for the time the model is working; it sleeps when idle and sleep is free."
              >
                ${perHourUsd.toFixed(perHourUsd >= 10 ? 0 : 2)}/hour
              </span>
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

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            props.onToggleFavorite();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
          type="button"
          disabled={disabled}
          aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          title={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
        >
          <StarIcon
            className={cn(
              "size-3.5 sm:size-3",
              props.isFavorite && "fill-current text-yellow-500",
              (!props.isFavorite || props.favoriteStarOnHover) &&
                "opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100 pointer-coarse:opacity-100",
            )}
          />
        </button>
        {props.jumpLabel ? (
          <Kbd className="h-4 min-w-0 shrink-0 rounded-sm px-1.5 text-[10px]">
            {props.jumpLabel}
          </Kbd>
        ) : null}
      </div>
    </ComboboxItem>
  );
});
