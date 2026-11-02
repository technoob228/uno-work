/**
 * The model and everything that tunes it in one control (Misha 01.11: "reasoning
 * goes with the model, not in its own dropdown", after T3's and bb's pickers).
 * The trigger says the level as bars, Fast as a bolt and the context window; the
 * picker's popup docks the levels beside the list and speed and permissions
 * under both.
 */
import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";
import {
  CheckIcon,
  ChevronUpIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

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
import { EffortGlyph, resolveEffortGlyph } from "./EffortGlyph";
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

const RUNTIME_MODE_ICON: Record<RuntimeMode, LucideIcon> = {
  "approval-required": LockIcon,
  "auto-accept-edits": PenLineIcon,
  "full-access": LockOpenIcon,
};

function isFast(descriptor: ProviderOptionDescriptor) {
  return descriptor.id === "fastMode" && descriptor.type === "boolean";
}

/** What the trigger shows after the model's name, and the same in words. */
function describeModelEffort(traits: ModelEffortTraits) {
  const visibility = getTraitsSectionVisibility(traits);
  if (!visibility.hasAnyControls) return { suffix: null, detail: null };
  const reasoning = visibility.primarySelectDescriptor;
  const glyph = reasoning
    ? resolveEffortGlyph(
        reasoning,
        visibility.ultrathinkPromptControlled
          ? "ultrathink"
          : (getDescriptorStringValue(reasoning) ?? null),
      )
    : null;
  const word = visibility.ultrathinkPromptControlled
    ? "Ultrathink"
    : (glyph?.special ?? (reasoning && !glyph ? getProviderOptionCurrentLabel(reasoning) : null));
  const fast = visibility.fastModeDescriptor?.currentValue === true;
  const contextWindow = visibility.contextWindowDescriptor
    ? getProviderOptionCurrentLabel(visibility.contextWindowDescriptor)
    : null;
  const detail = getTraitsSummaryLabel(traits) || null;
  if (!word && !glyph && !fast && !contextWindow) return { suffix: null, detail };
  return {
    detail,
    suffix: (
      <span
        className="flex shrink-0 items-center gap-1.5 text-muted-foreground"
        data-testid="model-effort-suffix"
      >
        {word ? (
          <span className="max-w-20 truncate text-xs">{word}</span>
        ) : glyph ? (
          <EffortGlyph count={glyph.count} filled={glyph.filled} />
        ) : null}
        {fast ? <ZapIcon aria-hidden="true" className="size-3 shrink-0 fill-current" /> : null}
        {contextWindow ? <span className="text-xs">{contextWindow}</span> : null}
      </span>
    ),
  };
}

function ColumnRow(props: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      onClick={props.onClick}
      data-testid={props.testId}
      className={cn(
        "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-60",
        props.selected && "font-medium",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.selected ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
    </button>
  );
}

/** The selected model's levels and its other choices, beside the model list. */
function ModelEffortColumn({ traits }: { traits: ModelEffortTraits }) {
  const {
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    handleSelectChange,
    handleBooleanChange,
  } = useTraitsControls(traits);
  const toggles = booleanDescriptors.filter((descriptor) => !isFast(descriptor));
  const locked = (descriptor: SelectDescriptor) =>
    ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id;
  return (
    <>
      {selectDescriptors.map((descriptor) => {
        const current =
          ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
            ? "ultrathink"
            : (getDescriptorStringValue(descriptor) ?? "");
        return (
          <div key={descriptor.id} role="radiogroup" aria-label={descriptor.label}>
            <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
              {descriptor.label}
            </div>
            {locked(descriptor) ? (
              <div className="px-2 pb-1.5 text-xs text-muted-foreground/80">
                Your prompt contains &quot;ultrathink&quot;. Remove it to change this.
              </div>
            ) : null}
            {descriptor.options.map((option) => (
              <ColumnRow
                key={option.id}
                label={option.label}
                selected={option.id === current}
                disabled={locked(descriptor)}
                testId={`model-effort-${descriptor.id}-${option.id}`}
                onClick={() => handleSelectChange(descriptor, option.id)}
              />
            ))}
          </div>
        );
      })}
      {toggles.map((descriptor) => (
        <div key={descriptor.id} role="radiogroup" aria-label={descriptor.label}>
          <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
            {descriptor.label}
          </div>
          {[true, false].map((value) => (
            <ColumnRow
              key={String(value)}
              label={value ? "On" : "Off"}
              selected={(descriptor.currentValue === true) === value}
              testId={`model-effort-${descriptor.id}-${value ? "on" : "off"}`}
              onClick={() => handleBooleanChange(descriptor.id, value)}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function FastSwitch({ traits }: { traits: ModelEffortTraits }) {
  const { fastModeDescriptor, handleBooleanChange } = useTraitsControls(traits);
  if (!fastModeDescriptor) return <span />;
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <ZapIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
      Fast
      <Switch
        checked={fastModeDescriptor.currentValue === true}
        onCheckedChange={(checked) => handleBooleanChange(fastModeDescriptor.id, checked)}
        aria-label="Fast"
        data-testid="model-picker-fast"
      />
    </label>
  );
}

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
        className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Current aria-hidden="true" className="size-3.5" />
        {PERMISSION_MODES[props.runtimeMode].label}
        <ChevronUpIcon aria-hidden="true" className="size-3 opacity-60" />
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
 * Everything `ProviderModelPicker` needs to carry the model's options. A model
 * with none gets no column: nothing to explain to someone on Uno Smart.
 * Permissions are for a box with no chip of their own.
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
  const hasColumn =
    (visibility?.selectDescriptors.length ?? 0) > 0 ||
    (visibility?.booleanDescriptors.some((descriptor) => !isFast(descriptor)) ?? false);
  const footer =
    (traits && visibility?.fastModeDescriptor) || permissions ? (
      <div
        className="flex items-center justify-between gap-3 border-t border-border/70 px-3 py-1.5"
        data-testid="model-picker-footer"
      >
        {traits ? <FastSwitch traits={traits} /> : <span />}
        {permissions ? <PermissionsMenu {...permissions} /> : null}
      </div>
    ) : null;
  return {
    triggerSuffix: suffix,
    triggerDetail: detail,
    effortColumn: traits && hasColumn ? <ModelEffortColumn traits={traits} /> : null,
    footer,
  };
}
