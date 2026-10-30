/**
 * The pin in a Home widget's title: keeps the widget one click away in the
 * icon row of the sidebar (SidebarPinRow.tsx). Shown on hover of the widget.
 */
import type { EnvironmentId, UnoMachineApp } from "@t3tools/contracts";
import { PinIcon, PinOffIcon } from "lucide-react";

import { widgetPinTarget } from "../../../navigation/pins";
import { usePins } from "../../../navigation/usePins";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { useAppWidgetPinTarget } from "./HomeAppWidget";
import { HOME_WIDGETS } from "./HomeWidgets";
import type { PinnableHomeWidgetId } from "./homeModel";

function PinToggle(props: { pinned: boolean; title: string; onToggle: () => void }) {
  const label = props.pinned ? "Unpin from the sidebar" : "Pin to the sidebar";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${label}: ${props.title}`}
            aria-pressed={props.pinned}
            data-testid="home-widget-pin"
            onClick={props.onToggle}
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/widget:opacity-100 aria-pressed:opacity-100 max-md:opacity-100"
          />
        }
      >
        {props.pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function HomeWidgetPin({ id }: { id: PinnableHomeWidgetId }) {
  const { isPinned, toggle } = usePins();
  const title = HOME_WIDGETS[id].title;
  const target = widgetPinTarget(id);
  return (
    <PinToggle
      title={title}
      pinned={isPinned("app", target)}
      onToggle={() => toggle({ kind: "app", title, target, icon: null })}
    />
  );
}

export function HomeAppWidgetPin({
  app,
  environmentId,
}: {
  app: UnoMachineApp;
  environmentId: EnvironmentId | null;
}) {
  const { isPinned, toggle } = usePins();
  const target = useAppWidgetPinTarget(app, environmentId);
  if (target === null) return null;
  return (
    <PinToggle
      title={app.name}
      pinned={isPinned("app", target)}
      onToggle={() => toggle({ kind: "app", title: app.name, target, icon: app.icon })}
    />
  );
}
