/**
 * Search-result row for a provider that has no models to offer yet. Typing
 * "claude" on a machine without Claude still finds the agent; choosing the
 * row opens its Install / Sign in pane instead of picking a model.
 *
 * @module components/chat/ProviderSetupListRow
 */
import { memo } from "react";
import { ChevronRightIcon } from "lucide-react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { ComboboxItem } from "../ui/combobox";
import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { providerSetupKey, type ProviderPaneBadge } from "./modelPickerProviderPane";

export const ProviderSetupListRow = memo(function ProviderSetupListRow(props: {
  index: number;
  entry: ProviderInstanceEntry;
  badge: ProviderPaneBadge;
}) {
  const action = props.badge === "Sign in needed" ? "Sign in" : "Set up";
  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={providerSetupKey(props.entry.instanceId)}
      contentClassName="flex w-full items-center gap-2"
      data-model-picker-setup-row={props.entry.instanceId}
      className={cn(
        "w-full cursor-pointer rounded px-3 py-2 transition-colors group",
        "data-highlighted:bg-muted data-selected:bg-accent data-selected:text-foreground",
      )}
    >
      <ProviderInstanceIcon
        driverKind={props.entry.driverKind}
        iconText={props.entry.iconText}
        displayName={props.entry.displayName}
        accentColor={props.entry.accentColor}
        className="size-5"
        iconClassName="size-4"
      />
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-xs font-medium leading-snug">{props.entry.displayName}</div>
        <div className="text-xs leading-snug text-muted-foreground/70">{props.badge}</div>
      </div>
      <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-muted-foreground">
        {action}
        <ChevronRightIcon className="size-3" aria-hidden />
      </span>
    </ComboboxItem>
  );
});
