/**
 * Home — "start work first": a greeting, the composer, what needs you,
 * "Continue" with the chats worth picking up, and the person's widgets.
 * The computer itself lives in the header pill; the log stream lives in
 * "What's using my computer".
 */
import type { EnvironmentId, UnoMachineApp } from "@t3tools/contracts";
import { CheckIcon, PencilIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { accountReachable } from "../../myuno/myUnoQueries";
import { Button } from "../../ui/button";
import type { BuiltInPrograms } from "../ComputerPrograms";
import type { ProgramTile } from "../programModel";
import { ComputerDetails, type HomeComputer } from "./ComputerPill";
import { HomeComposer, type HomeStartOptions } from "./HomeComposer";
import {
  ContinueCards,
  NeedsYouPill,
  NeedsYouWidget,
  RecentChatsWidget,
  useHomeThreads,
} from "./HomeThreads";
import {
  AiSpendWidget,
  AppsWidget,
  CloudUsageLink,
  CloudWidget,
  FilesWidget,
  SitesWidget,
} from "./HomeWidgetBodies";
import { AddWidgetDialog, HomeWidgetGrid } from "./HomeWidgets";
import { usePersonFirstName } from "./useHomeInfo";
import {
  DEFAULT_HOME_WIDGETS,
  HOME_WIDGET_IDS,
  greeting,
  homeWidgetsReducer,
  normalizeHomeWidgets,
  type HomeWidgetId,
  type HomeWidgetsAction,
} from "./homeModel";

const HOME_WIDGETS_KEY = "uno-work:home:widgets";

/** The layout (per device) and the Customize mode, shared by the header and the body. */
export function useHomeLayout() {
  const [stored, setStored] = useLocalStorage<ReadonlyArray<string>, ReadonlyArray<string>>(
    HOME_WIDGETS_KEY,
    DEFAULT_HOME_WIDGETS,
    Schema.Array(Schema.String),
  );
  const widgets = useMemo(() => normalizeHomeWidgets(stored), [stored]);
  const dispatch = useCallback(
    (action: HomeWidgetsAction) =>
      setStored((previous) => homeWidgetsReducer(normalizeHomeWidgets(previous), action)),
    [setStored],
  );
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  return { widgets, dispatch, editing, setEditing, adding, setAdding };
}

export type HomeLayout = ReturnType<typeof useHomeLayout>;

/** Header buttons: Customize, or Reset / Add widget / Done while customizing. */
export function HomeHeaderActions({ layout, pill }: { layout: HomeLayout; pill: ReactNode }) {
  if (layout.editing) {
    return (
      <>
        <Button size="xs" variant="ghost" onClick={() => layout.dispatch({ type: "reset" })}>
          <RotateCcwIcon />
          Reset
        </Button>
        <Button size="xs" variant="outline" onClick={() => layout.setAdding(true)}>
          <PlusIcon />
          Add widget
        </Button>
        <Button
          size="xs"
          onClick={() => layout.setEditing(false)}
          data-testid="home-customize-done"
        >
          <CheckIcon />
          Done
        </Button>
      </>
    );
  }
  return (
    <>
      {pill}
      <Button
        size="xs"
        variant="ghost"
        onClick={() => layout.setEditing(true)}
        data-testid="home-customize"
      >
        <PencilIcon />
        Customize
      </Button>
    </>
  );
}

export function HomeStart({
  environmentId,
  layout,
  computer,
  notices,
  builtIns,
  tiles,
  appsLoading,
  onOpenTile,
  onTileDetails,
  hiddenApps,
  unhidingId,
  onUnhide,
  onStartTask,
}: {
  environmentId: EnvironmentId | null;
  layout: HomeLayout;
  computer: HomeComputer | null;
  /** Account / linking notices, the "your Uno computers" picker, errors. */
  notices: ReactNode;
  builtIns: BuiltInPrograms;
  tiles: ReadonlyArray<ProgramTile>;
  appsLoading: boolean;
  onOpenTile: (tile: ProgramTile) => void;
  onTileDetails: (tile: ProgramTile) => void;
  /** Found programs hidden from Home, listed under the Apps widget with "Show on Home". */
  hiddenApps: ReadonlyArray<UnoMachineApp>;
  unhidingId: string | null;
  onUnhide: (appId: string) => void;
  onStartTask: (prompt: string, options: HomeStartOptions) => Promise<void>;
}) {
  const { threads, now } = useHomeThreads();
  const firstName = usePersonFirstName(environmentId);
  const available = useMemo(
    () =>
      HOME_WIDGET_IDS.filter(
        (id) => (id !== "sites" || accountReachable()) && (id !== "computer" || computer !== null),
      ),
    [computer],
  );
  const shown = layout.widgets.filter((id) => available.includes(id));

  const render = (id: HomeWidgetId): { body: ReactNode; action?: ReactNode } => {
    switch (id) {
      case "files":
        return {
          body: <FilesWidget environmentId={environmentId} />,
          action: <CloudUsageLink environmentId={environmentId} />,
        };
      case "apps":
        return {
          body: (
            <AppsWidget
              builtIns={builtIns}
              tiles={tiles}
              loading={appsLoading}
              onOpenTile={onOpenTile}
              onTileDetails={onTileDetails}
              hiddenApps={hiddenApps}
              unhidingId={unhidingId}
              onUnhide={onUnhide}
            />
          ),
        };
      case "computer":
        return { body: computer ? <ComputerDetails computer={computer} compact /> : null };
      case "needs-you":
        return { body: <NeedsYouWidget threads={threads} now={now} /> };
      case "recent-chats":
        return {
          body: <RecentChatsWidget threads={threads} now={now} onNewChat={builtIns.onNewChat} />,
        };
      case "cloud":
        return { body: <CloudWidget environmentId={environmentId} /> };
      case "sites":
        return { body: <SitesWidget /> };
      case "ai-spend":
        return { body: <AiSpendWidget environmentId={environmentId} /> };
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 pt-6 pb-16 sm:pt-12">
      <div className="flex flex-col gap-4">
        <h1 className="text-[28px] font-semibold tracking-tight" data-testid="home-greeting">
          {greeting(new Date(now).getHours())}
          {firstName ? `, ${firstName}` : null}
        </h1>
        <HomeComposer environmentId={environmentId} onStart={onStartTask} />
        <NeedsYouPill threads={threads} now={now} />
      </div>

      {notices}

      <section className="flex flex-col gap-2.5">
        <h2 className="text-sm font-semibold">Continue</h2>
        <ContinueCards threads={threads} now={now} />
      </section>

      <section className="flex flex-col gap-2.5">
        {layout.editing ? (
          <p className="text-xs text-muted-foreground">Drag widgets to rearrange, × to remove.</p>
        ) : null}
        {shown.length > 0 || layout.editing ? (
          <HomeWidgetGrid
            widgets={shown}
            editing={layout.editing}
            dispatch={layout.dispatch}
            onAdd={() => layout.setAdding(true)}
            render={render}
          />
        ) : null}
        {!layout.editing && shown.length < available.length ? (
          <button
            type="button"
            onClick={() => layout.setAdding(true)}
            className="flex items-center gap-1.5 self-start rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
            Add a widget
          </button>
        ) : null}
      </section>

      <AddWidgetDialog
        open={layout.adding}
        onOpenChange={layout.setAdding}
        widgets={shown}
        available={available}
        dispatch={layout.dispatch}
      />
    </div>
  );
}
