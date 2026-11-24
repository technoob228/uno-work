/**
 * The model and everything that tunes it in one control, laid out as T3 Code's
 * (upstream `ComposerModelEffort.tsx`, pingdotgg/t3code f99ef08b: #28057 one
 * control, #28162 Default or the checkmark, #28044 no Ultrathink row, #40798
 * typeahead). Misha 24.11: "exactly like in T3 Code".
 *
 * The trigger names the level after the model ("Opus 5.5 High ⚡ 1M"). The
 * popup docks a column beside the list: a header naming the reasoning control
 * and the model, its levels, then one row per other option (context window,
 * agent mode) that opens its choices beside the column. Speed and permissions
 * sit in the footer under both.
 */
import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";
import {
  CheckIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  WorkflowIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, createContext, use, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { PERMISSION_MODES, PERMISSION_MODE_ORDER, plainLabel } from "../../plainLanguage";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getDescriptorStringValue,
  getTraitsSectionVisibility,
  getTraitsSummaryLabel,
  type TraitsMenuContentProps,
  type TraitsPersistence,
  useTraitsControls,
} from "./TraitsPicker";

export type ModelEffortTraits = TraitsMenuContentProps & TraitsPersistence;

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

/** What a docked column needs from its picker: the model it serves (upstream `DockedPickerContext`). */
export const DockedPickerContext = createContext<{ modelLabel: string }>({ modelLabel: "" });

const RUNTIME_MODE_ICON: Record<RuntimeMode, LucideIcon> = {
  "approval-required": LockIcon,
  "auto-accept-edits": PenLineIcon,
  "full-access": LockOpenIcon,
};

/** Upstream `REASONING_EFFORT_OPTION_IDS` plus Haiku's on/off "thinking". */
const REASONING_DESCRIPTOR_IDS: ReadonlySet<string> = new Set([
  "reasoningEffort",
  "effort",
  "reasoning",
  "thinking",
]);

function isReasoningControl(descriptor: ProviderOptionDescriptor): boolean {
  return REASONING_DESCRIPTOR_IDS.has(descriptor.id);
}

/** A level the prompt sets (Ultrathink) is typed, not picked: the column leaves it out. */
function selectableChoices(descriptor: SelectDescriptor) {
  return descriptor.options.filter(
    (option) => !descriptor.promptInjectedValues?.includes(option.id),
  );
}

/** Service tiers, Fast and an Ultracode switch sit in the footer, not the column. */
function splitSpeed(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const speedSelect = selects.find((descriptor) => descriptor.id === "serviceTier") ?? null;
  const fastToggle = toggles.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const ultracodeToggle = toggles.find((descriptor) => descriptor.id === "ultracode") ?? null;
  return {
    speedSelect,
    fastToggle,
    ultracodeToggle,
    columnSelects: selects.filter((descriptor) => descriptor !== speedSelect),
    columnToggles: toggles.filter(
      (descriptor) => descriptor !== fastToggle && descriptor !== ultracodeToggle,
    ),
  };
}

type ColumnControl =
  | { kind: "select"; descriptor: SelectDescriptor }
  | { kind: "boolean"; descriptor: BooleanDescriptor };

/** The model's reasoning levels head the column; every other option is one row below. */
function columnControls(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const { columnSelects, columnToggles } = splitSpeed(selects, toggles);
  const controls: ReadonlyArray<ColumnControl> = [
    ...columnSelects.map((descriptor) => ({ kind: "select" as const, descriptor })),
    ...columnToggles.map((descriptor) => ({ kind: "boolean" as const, descriptor })),
  ];
  const effort = controls.find((control) => isReasoningControl(control.descriptor)) ?? null;
  return { effort, others: controls.filter((control) => control !== effort) };
}

/**
 * What the trigger shows after the model's name: the level as a word (upstream's
 * default `effortDisplay: "label"`), a bolt for Fast, a workflow icon for an
 * Ultracode switch, and the context window.
 */
function describeModelEffort(traits: ModelEffortTraits) {
  const visibility = getTraitsSectionVisibility(traits);
  if (!visibility.hasAnyControls) return { suffix: null, detail: null };
  const reasoning =
    columnControls(visibility.selectDescriptors, visibility.booleanDescriptors).effort
      ?.descriptor ?? null;
  const ultrathink =
    visibility.ultrathinkPromptControlled &&
    reasoning?.id === visibility.primarySelectDescriptor?.id;
  const word = !reasoning
    ? null
    : ultrathink
      ? "Ultrathink"
      : reasoning.type === "boolean"
        ? reasoning.currentValue === true
          ? `${reasoning.label} On`
          : `${reasoning.label} Off`
        : (getProviderOptionCurrentLabel(reasoning) ?? null);
  const { fastToggle, speedSelect, ultracodeToggle } = splitSpeed(
    visibility.selectDescriptors,
    visibility.booleanDescriptors,
  );
  const speed = speedSelect ? getProviderOptionCurrentLabel(speedSelect) : null;
  const fast = fastToggle?.currentValue === true || speed === "Fast" || speed === "Ultrafast";
  const ultracode = ultracodeToggle?.currentValue === true;
  const contextWindow = visibility.contextWindowDescriptor
    ? getProviderOptionCurrentLabel(visibility.contextWindowDescriptor)
    : null;
  const detail = getTraitsSummaryLabel(traits) || null;
  if (!word && !fast && !ultracode && !contextWindow) return { suffix: null, detail };
  return {
    detail,
    suffix: (
      <span
        // Same color as the model's name: one control, one voice.
        className="flex shrink-0 items-center gap-1.5"
        data-testid="model-effort-suffix"
      >
        {word ? <span className="max-w-24 truncate">{word}</span> : null}
        {fast ? <ZapIcon aria-hidden="true" className="size-3 shrink-0 fill-current" /> : null}
        {ultracode ? <WorkflowIcon aria-hidden="true" className="size-3 shrink-0" /> : null}
        {contextWindow ? <span className="max-w-24 truncate text-xs">{contextWindow}</span> : null}
      </span>
    ),
  };
}

const COLUMN_ROW =
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.09] focus-visible:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-64";

function ColumnRow(props: {
  label: string;
  /** Shown on hover; the column is too narrow to print it under the label. */
  description?: string | undefined;
  selected: boolean;
  /** The column's one tab stop: the selected level, else the first. */
  tabStop: boolean;
  isDefault?: boolean | undefined;
  disabled?: boolean;
  testId: string;
  onPick: () => void;
}) {
  const rowProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.selected,
    disabled: props.disabled,
    "data-effort-row": true,
    // Focus lands on a level after a model pick, and a typed letter finds one by its label.
    "data-effort-level": props.label,
    "data-testid": props.testId,
    tabIndex: props.tabStop ? 0 : -1,
    className: COLUMN_ROW,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.selected ? (
        <>
          {props.isDefault ? <span className="sr-only">Default</span> : null}
          <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
        </>
      ) : props.isDefault ? (
        <span className="text-muted-foreground/70 text-xs">Default</span>
      ) : null}
    </>
  );
  if (!props.description) return <button {...rowProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...rowProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="right" className="max-w-56">
        {props.description}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Up and Down move between rows; a letter jumps to the next row starting with it. */
function moveBetweenRows(event: KeyboardEvent<HTMLElement>) {
  const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
  if (
    !arrow &&
    (event.key.length !== 1 ||
      event.key.trim() === "" ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.nativeEvent.isComposing)
  )
    return;
  // An option's side menu is a React child here, but it moves through its own items.
  if (!event.currentTarget.contains(event.target as Node)) return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-effort-row]:not(:disabled)"),
  );
  const index = rows.findIndex((row) => row === document.activeElement);
  const next = arrow
    ? rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))]
    : [...rows.slice(index + 1), ...rows.slice(0, index + 1)].find((row) =>
        row.dataset.effortLevel?.toLowerCase().startsWith(event.key.toLowerCase()),
      );
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

type TraitsControls = ReturnType<typeof useTraitsControls>;

function EffortLevels({ traits: input }: { traits: ModelEffortTraits }) {
  const traits = useTraitsControls(input);
  const { effort, others } = columnControls(traits.selectDescriptors, traits.booleanDescriptors);
  if (!effort && others.length === 0) return <NoEffortRow />;
  // Ultrathink in the prompt locks the levels; the first option then holds the tab stop.
  const locked =
    effort?.descriptor.id === traits.primarySelectDescriptor?.id && traits.ultrathinkInBodyText;
  return (
    <>
      {effort ? <EffortRows control={effort} traits={traits} locked={locked} /> : null}
      {others.length > 0 ? (
        <div
          className={cn("flex flex-col gap-0.5", effort && "mt-1 border-t border-border/70 pt-1")}
        >
          {others.map((control, index) =>
            control.kind === "boolean" ? (
              <OptionSwitchRow
                key={control.descriptor.id}
                descriptor={control.descriptor}
                traits={traits}
                tabStop={(!effort || locked) && index === 0}
              />
            ) : (
              <OptionMenuRow
                key={control.descriptor.id}
                descriptor={control.descriptor}
                traits={traits}
                tabStop={(!effort || locked) && index === 0}
              />
            ),
          )}
        </div>
      ) : null}
    </>
  );
}

function EffortRows(props: { control: ColumnControl; traits: TraitsControls; locked: boolean }) {
  const { control, traits, locked } = props;
  const { descriptor } = control;
  if (control.kind === "boolean") {
    const on = control.descriptor.currentValue === true;
    return (
      <div role="radiogroup" aria-label={descriptor.label} className="flex flex-col gap-0.5">
        {([true, false] as const).map((value) => (
          <ColumnRow
            key={String(value)}
            label={value ? "On" : "Off"}
            selected={on === value}
            tabStop={on === value}
            testId={`model-effort-${descriptor.id}-${value ? "on" : "off"}`}
            onPick={() => traits.handleBooleanChange(descriptor.id, value)}
          />
        ))}
      </div>
    );
  }
  const value = getDescriptorStringValue(control.descriptor);
  const choices = selectableChoices(control.descriptor);
  // An "Ultrathink:" prefix selects a level the column does not offer.
  const shown = !traits.ultrathinkPromptControlled && choices.some((option) => option.id === value);
  return (
    <div role="radiogroup" aria-label={descriptor.label} className="flex flex-col gap-0.5">
      {locked ? (
        <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
          Your prompt contains &quot;ultrathink&quot;. Remove it to change this.
        </div>
      ) : null}
      {choices.map((option, index) => (
        <ColumnRow
          key={option.id}
          label={option.label}
          selected={shown && option.id === value}
          tabStop={shown ? option.id === value : index === 0}
          description={option.description}
          isDefault={option.isDefault}
          disabled={locked}
          testId={`model-effort-${descriptor.id}-${option.id}`}
          onPick={() => traits.handleSelectChange(control.descriptor, option.id)}
        />
      ))}
    </div>
  );
}

const OPTION_ROW = cn(COLUMN_ROW, "h-auto py-1");

/** An option's name over its current value. */
function OptionRowText(props: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-muted-foreground text-xs">{props.label}</span>
      <span className="truncate">{props.value}</span>
    </span>
  );
}

/**
 * One select besides reasoning, such as the context window. It names the current
 * choice and opens the rest beside the column, so the levels stay in place.
 */
function OptionMenuRow(props: {
  descriptor: SelectDescriptor;
  traits: TraitsControls;
  tabStop: boolean;
}) {
  const { descriptor, traits } = props;
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const choices = selectableChoices(descriptor);
  const value = getDescriptorStringValue(descriptor) ?? "";
  const current = choices.find((choice) => choice.id === value)?.label ?? "";
  return (
    <Menu
      open={open}
      // A modal menu would cover the picker, so the next click there would only close it.
      modal={false}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) return;
        const checked = popupRef.current?.querySelector<HTMLElement>(
          '[role="menuitemradio"][aria-checked="true"]',
        );
        checked?.focus({ preventScroll: true });
      }}
    >
      <MenuTrigger
        render={
          <button
            type="button"
            data-effort-row
            data-testid={`model-effort-${descriptor.id}`}
            tabIndex={props.tabStop ? 0 : -1}
            aria-label={`${descriptor.label}: ${current}`}
            className={cn(OPTION_ROW, "data-popup-open:bg-foreground/[0.09]")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }}
          />
        }
      >
        <OptionRowText label={descriptor.label} value={current} />
        <ChevronRightIcon
          aria-hidden="true"
          className="-me-1 size-3.5 shrink-0 text-muted-foreground"
        />
      </MenuTrigger>
      <MenuPopup
        ref={popupRef}
        side="right"
        align="start"
        sideOffset={6}
        className="max-w-72"
        data-model-picker-option-menu
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft") return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <MenuRadioGroup
          aria-label={descriptor.label}
          value={value}
          onValueChange={(next: string) => {
            if (next !== value) traits.handleSelectChange(descriptor, next);
          }}
        >
          {choices.map((choice) => (
            <MenuRadioItem
              key={choice.id}
              value={choice.id}
              closeOnClick
              data-testid={`model-effort-${descriptor.id}-${choice.id}`}
            >
              <span className="flex items-center gap-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{choice.label}</span>
                  {choice.description ? (
                    <span className="line-clamp-2 text-muted-foreground text-xs">
                      {choice.description}
                    </span>
                  ) : null}
                </span>
                {choice.isDefault ? (
                  <span className="text-muted-foreground/70 text-xs">Default</span>
                ) : null}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** A two-state option toggles in place; a menu would add a click for nothing. */
function OptionSwitchRow(props: {
  descriptor: BooleanDescriptor;
  traits: TraitsControls;
  tabStop: boolean;
}) {
  const { descriptor, traits } = props;
  const checked = descriptor.currentValue === true;
  return (
    <label className={cn(OPTION_ROW, "has-focus-visible:bg-foreground/[0.09]")}>
      <OptionRowText label={descriptor.label} value={checked ? "On" : "Off"} />
      <Switch
        checked={checked}
        onCheckedChange={(next) => traits.handleBooleanChange(descriptor.id, next)}
        aria-label={descriptor.label}
        data-effort-row
        data-testid={`model-effort-${descriptor.id}`}
        tabIndex={props.tabStop ? 0 : -1}
      />
    </label>
  );
}

function NoEffortRow() {
  return (
    <div
      className="flex h-8 items-center px-2 text-muted-foreground text-sm"
      data-testid="model-effort-none"
    >
      No effort levels
    </div>
  );
}

/** The picker's effort column: the selected model's levels and its other options. */
function ModelEffortColumn({ traits }: { traits: ModelEffortTraits | null }) {
  const picker = use(DockedPickerContext);
  const visibility = traits ? getTraitsSectionVisibility(traits) : null;
  const controls = visibility
    ? columnControls(visibility.selectDescriptors, visibility.booleanDescriptors)
    : null;
  return (
    <>
      {/* Matches the search row's box, so one rule runs across the top of the popup. */}
      <div className="shrink-0 px-3 pt-2.5">
        <div className="flex h-8.25 -translate-y-px items-center gap-2 border-b border-border/70 pb-1.5 text-sm">
          <span className="text-muted-foreground">
            {controls?.effort?.descriptor.label ?? (controls?.others.length ? "Options" : "Effort")}
          </span>
          <span className="ms-auto min-w-0 truncate text-muted-foreground text-xs">
            {picker.modelLabel}
          </span>
        </div>
      </div>
      {/* pt-2.5 puts the first level on the same line as the first model. */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pt-2.5 pb-1.5"
        // Capture, so Up and Down on an option row move rows instead of opening its menu.
        onKeyDownCapture={moveBetweenRows}
      >
        {traits ? <EffortLevels traits={traits} /> : <NoEffortRow />}
      </div>
    </>
  );
}

const FOOTER_SEGMENT =
  "flex h-6 cursor-pointer items-center justify-center gap-1 px-2 text-muted-foreground text-xs outline-none first:rounded-l-md last:rounded-r-md hover:text-foreground data-checked:bg-input/72 data-checked:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function SpeedSegment(props: {
  checked: boolean;
  label: string;
  description?: string | undefined;
  testId?: string;
  onPick: () => void;
}) {
  const buttonProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.checked,
    "data-checked": props.checked || undefined,
    "data-testid": props.testId,
    className: FOOTER_SEGMENT,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      {props.label === "Fast" || props.label === "Ultrafast" ? (
        <ZapIcon aria-hidden="true" className="size-3 fill-current" />
      ) : null}
      {props.label}
    </>
  );
  if (!props.description) return <button {...buttonProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...buttonProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="top">{props.description}</TooltipPopup>
    </Tooltip>
  );
}

/** Standard | Fast, one click away (upstream `SpeedControl`). */
function SpeedControl({ traits: input }: { traits: ModelEffortTraits }) {
  const traits = useTraitsControls(input);
  const { speedSelect, fastToggle } = splitSpeed(
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
  if (!speedSelect && !fastToggle) return null;
  return (
    <div
      role="radiogroup"
      aria-label={speedSelect?.label ?? fastToggle?.label}
      className="flex rounded-lg bg-input/40 p-0.5"
    >
      {speedSelect
        ? selectableChoices(speedSelect).map((option) => (
            <SpeedSegment
              key={option.id}
              checked={option.id === getDescriptorStringValue(speedSelect)}
              label={option.label}
              description={option.description}
              testId={`model-picker-speed-${option.id}`}
              onPick={() => traits.handleSelectChange(speedSelect, option.id)}
            />
          ))
        : fastToggle
          ? ([false, true] as const).map((value) => (
              <SpeedSegment
                key={String(value)}
                checked={(fastToggle.currentValue === true) === value}
                label={value ? "Fast" : "Standard"}
                testId={value ? "model-picker-fast" : "model-picker-standard"}
                onPick={() => traits.handleBooleanChange(fastToggle.id, value)}
              />
            ))
          : null}
    </div>
  );
}

/** An Ultracode switch beside the speed, when the agent offers one apart from the levels. */
function UltracodeControl({ traits: input }: { traits: ModelEffortTraits }) {
  const traits = useTraitsControls(input);
  const { ultracodeToggle } = splitSpeed(traits.selectDescriptors, traits.booleanDescriptors);
  if (!ultracodeToggle) return null;
  const on = ultracodeToggle.currentValue === true;
  return (
    <div className="flex rounded-lg bg-input/40 p-0.5">
      <button
        type="button"
        aria-pressed={on}
        data-checked={on || undefined}
        className={FOOTER_SEGMENT}
        onClick={() => traits.handleBooleanChange(ultracodeToggle.id, !on)}
      >
        <WorkflowIcon aria-hidden="true" className="size-3" />
        {ultracodeToggle.label}
      </button>
    </div>
  );
}

/** Permissions change rarely, so the footer names the mode and nests the choice in a menu. */
function PermissionsMenu(props: {
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const Current = RUNTIME_MODE_ICON[props.runtimeMode];
  return (
    <Menu>
      <MenuTrigger
        aria-label={`${plainLabel("permissions")}: ${PERMISSION_MODES[props.runtimeMode].label}`}
        data-testid="model-picker-permissions"
        className="ms-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs outline-none hover:bg-foreground/[0.09] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-foreground/[0.09] data-popup-open:text-foreground"
      >
        <Current aria-hidden="true" className="size-3.5" />
        {PERMISSION_MODES[props.runtimeMode].label}
        <ChevronUpIcon aria-hidden="true" className="size-3" />
      </MenuTrigger>
      <MenuPopup align="end" side="top" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel>{plainLabel("permissions")}</MenuGroupLabel>
          <MenuRadioGroup
            value={props.runtimeMode}
            onValueChange={(value) => props.onRuntimeModeChange(value as RuntimeMode)}
          >
            {PERMISSION_MODE_ORDER.map((mode) => {
              const Icon = RUNTIME_MODE_ICON[mode];
              return (
                <MenuRadioItem
                  key={mode}
                  value={mode}
                  className="py-2"
                  data-testid={`model-picker-permission-${mode}`}
                >
                  <span className="grid min-w-0 gap-0.5">
                    <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      {PERMISSION_MODES[mode].label}
                    </span>
                    <span className="text-xs leading-4 text-muted-foreground">
                      {PERMISSION_MODES[mode].consequence}
                    </span>
                  </span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/**
 * Everything `ProviderModelPicker` needs to carry the model's options, as T3's
 * composer passes them: the column is always docked (a model with no options
 * says "No effort levels"), the footer holds speed and, for a box with no
 * permissions chip of its own, permissions.
 */
export function modelEffortPickerProps(
  traits: ModelEffortTraits | null,
  permissions?: {
    runtimeMode: RuntimeMode;
    onRuntimeModeChange: (mode: RuntimeMode) => void;
  },
): {
  triggerSuffix?: ReactNode;
  triggerDetail?: string | null;
  effortColumn?: ReactNode;
  footer?: ReactNode;
} {
  if (!traits && !permissions) return {};
  const visibility = traits ? getTraitsSectionVisibility(traits) : null;
  const { suffix, detail } = traits ? describeModelEffort(traits) : { suffix: null, detail: null };
  const speed = visibility
    ? splitSpeed(visibility.selectDescriptors, visibility.booleanDescriptors)
    : null;
  const hasFooter =
    permissions !== undefined ||
    Boolean(speed?.fastToggle || speed?.speedSelect || speed?.ultracodeToggle);
  return {
    triggerSuffix: suffix,
    triggerDetail: detail,
    effortColumn: <ModelEffortColumn traits={traits} />,
    footer: hasFooter ? (
      <div
        className="flex flex-wrap items-center gap-2 border-t border-border/70 bg-muted/40 px-3 py-2"
        data-testid="model-picker-footer"
      >
        {traits ? <SpeedControl traits={traits} /> : null}
        {traits ? <UltracodeControl traits={traits} /> : null}
        {permissions ? <PermissionsMenu {...permissions} /> : null}
      </div>
    ) : null,
  };
}
