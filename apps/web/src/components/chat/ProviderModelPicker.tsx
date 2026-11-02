import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import { setModelPickerOpen } from "../../modelPickerOpenState";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useHarnessSetup } from "../harness/useHarnessSetup";

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  /**
   * The instance currently selected in the composer. Drives the trigger
   * icon, label and the default-highlighted combobox row.
   */
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** What picking here does in a started chat. */
  note?: string | null;
  /** Instance entries rendered in the sidebar + used to resolve display name. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /**
   * Machine whose providers these are. Installing or signing in to an agent
   * from the picker runs on this machine; omit for the primary machine.
   */
  environmentId?: EnvironmentId | null;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  allowImageGenerationModels?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onOpenChange?: (open: boolean) => void;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** After the model's name in the same trigger: its level, speed and context. */
  triggerSuffix?: ReactNode;
  /** The suffix in words, for the tooltip and screen readers. */
  triggerDetail?: string | null;
  /**
   * Docks a column beside the list and a footer under both, in one card. A pick
   * leaves the popup open on the new model's levels; null is a model with none.
   */
  effortColumn?: ReactNode;
  footer?: ReactNode;
}) {
  const docked = props.effortColumn !== undefined;
  const hasEffortColumn = Boolean(props.effortColumn);
  const justPicked = useRef(false);
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const environmentId = props.environmentId ?? null;
  // Lives on the trigger, not the popup, so an install started in the picker
  // keeps being polled while the popup is closed.
  const setup = useHarnessSetup(environmentId);
  // 16.10 (Misha): one picker for everyone, T3's — the harness column on
  // the left (Uno Hermes first), search and the model list on the right.
  // The 01.10 Smart / Fast / Premium popup is gone.

  // Resolve the active instance entry by exact routing key. The composer
  // resolves fallbacks before rendering this component; if the selected
  // instance disappears, do not infer a replacement from its driver kind.
  const activeEntry = useMemo(() => {
    return (
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null
    );
  }, [props.activeInstanceId, props.instanceEntries]);

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  // If the current slug belongs to a different instance (for example after
  // a provider switch or disable), prefer the active instance's first
  // option so the trigger icon and label stay in sync instead of showing
  // a stale foreign slug.
  const selectedModel =
    selectedInstanceOptions.find((option) => option.slug === props.model) ??
    selectedInstanceOptions[0];
  const triggerTitle = selectedModel ? getTriggerDisplayModelName(selectedModel) : props.model;
  const triggerSubtitle =
    selectedModel?.subProvider &&
    !triggerTitle
      .toLocaleLowerCase()
      .startsWith(`${selectedModel.subProvider}:`.toLocaleLowerCase())
      ? selectedModel.subProvider
      : undefined;
  const triggerLabel = selectedModel ? getTriggerDisplayModelLabel(selectedModel) : props.model;
  const duplicateDriverCount = props.instanceEntries.filter(
    (entry) => activeEntry !== null && entry.driverKind === activeEntry.driverKind,
  ).length;
  const showInstanceBadge = Boolean(activeEntry?.accentColor) || duplicateDriverCount > 1;

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  useEffect(() => {
    setModelPickerOpen(isMenuOpen);
    return () => {
      setModelPickerOpen(false);
    };
  }, [isMenuOpen]);

  // The new model's options arrive with its render: with none, the pick is the whole choice.
  useEffect(() => {
    if (!justPicked.current) return;
    justPicked.current = false;
    if (!hasEffortColumn) setIsMenuOpen(false);
  }, [props.activeInstanceId, props.model, hasEffortColumn]);

  const handleInstanceModelChange = (instanceId: ProviderInstanceId, model: string) => {
    if (props.disabled) return;
    props.onInstanceModelChange(instanceId, model);
    if (docked) justPicked.current = true;
    else setIsMenuOpen(false);
  };

  const picker = (
    <ModelPickerContent
      activeInstanceId={activeInstanceId}
      {...(docked ? { docked } : {})}
      model={props.model}
      lockedProvider={props.lockedProvider}
      lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
      note={props.note ?? null}
      instanceEntries={props.instanceEntries}
      {...(props.keybindings ? { keybindings: props.keybindings } : {})}
      modelOptionsByInstance={props.modelOptionsByInstance}
      terminalOpen={props.terminalOpen ?? false}
      allowImageGenerationModels={props.allowImageGenerationModels === true}
      setup={setup}
      environmentId={environmentId}
      onRequestClose={() => setIsMenuOpen(false)}
      onInstanceModelChange={handleInstanceModelChange}
    />
  );

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            aria-label={[triggerLabel, props.triggerDetail].filter(Boolean).join(", ")}
            className={cn(
              "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
              props.compact
                ? cn("shrink-0", props.triggerSuffix ? "max-w-58" : "max-w-42")
                : cn(
                    "shrink sm:px-3",
                    props.triggerSuffix ? "max-w-58 sm:max-w-66" : "max-w-48 sm:max-w-56",
                  ),
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn(
            "flex min-w-0 w-full box-border items-center gap-2 overflow-hidden",
            props.compact ? cn("sm:pl-1", !props.triggerSuffix && "max-w-36") : undefined,
          )}
        >
          {activeEntry ? (
            <ProviderInstanceIcon
              driverKind={activeEntry.driverKind}
              iconText={activeEntry.iconText}
              displayName={activeEntry.displayName}
              accentColor={activeEntry.accentColor}
              showBadge={showInstanceBadge}
              className={showInstanceBadge ? "size-5" : "size-4"}
              iconClassName={cn("size-4", props.activeProviderIconClassName)}
              badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 text-[7px]"
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "min-w-0 flex-1 overflow-hidden",
                    triggerSubtitle ? "flex items-center gap-1" : "truncate",
                  )}
                />
              }
            >
              {triggerSubtitle ? (
                <>
                  <span className="max-w-[6rem] shrink-0 truncate">{triggerSubtitle}</span>
                  <span aria-hidden="true" className="shrink-0 opacity-60">
                    ·
                  </span>
                  <span className="min-w-0 flex-1 truncate">{triggerTitle}</span>
                </>
              ) : (
                triggerTitle
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {[triggerLabel, props.triggerDetail].filter(Boolean).join(" · ")}
            </TooltipPopup>
          </Tooltip>
          {props.triggerSuffix}
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="border-0 bg-transparent p-0 shadow-none before:hidden [--viewport-inline-padding:0] *:data-[slot=popover-viewport]:p-0"
      >
        {docked ? (
          <div
            className="flex max-h-(--available-height) flex-col overflow-hidden rounded-lg border bg-popover shadow-lg"
            data-testid="model-picker-docked"
          >
            <div className="flex h-96 min-h-0 max-sm:h-auto max-sm:flex-col">
              {picker}
              {props.effortColumn ? (
                <div
                  className="flex min-h-0 w-44 flex-col gap-1 overflow-y-auto border-l border-border/70 bg-muted/40 p-1 max-sm:max-h-48 max-sm:w-full max-sm:border-t max-sm:border-l-0 sm:shrink-0"
                  data-testid="model-effort-column"
                >
                  {props.effortColumn}
                </div>
              ) : null}
            </div>
            {props.footer}
          </div>
        ) : (
          picker
        )}
      </PopoverPopup>
    </Popover>
  );
});
