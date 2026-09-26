/**
 * Home — "start work first". Every part of it is a block of one layout the
 * person arranges (homeLayout.ts): the greeting, the composer with its
 * suggestions, Continue (chats and notifications that need you), the
 * built-in widgets and apps' own widgets. Customize lives on the page itself,
 * next to "Add a widget"; the computer lives in the header pill.
 */
import { DEFAULT_RUNTIME_MODE, type EnvironmentId, type UnoMachineApp } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, PencilIcon, PlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { getLocalStorageItem, useLocalStorage } from "../../../hooks/useLocalStorage";
import { accountReachable } from "../../myuno/myUnoQueries";
import { Button } from "../../ui/button";
import type { BuiltInPrograms } from "../ComputerPrograms";
import { programRemoval, type ProgramTile } from "../programModel";
import { ComputerDetails, type HomeComputer } from "./ComputerPill";
import { HomeAppWidget, HomeAppWidgetOpen } from "./HomeAppWidget";
import { HomeComposer, type HomeStartOptions } from "./HomeComposer";
import { goalState } from "../../setup/goals";
import { useSetupProgress } from "../../setup/useSetupProgress";
import { HomeGoalButtons, HomeNextStep, useGoalWatcher } from "./HomeGoals";
import { HomeUnoEntry } from "./HomeUnoEntry";
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
import {
  AddWidgetDialog,
  HOME_FIXED_BLOCK_META,
  HOME_WIDGETS,
  HomeWidgetGrid,
  type AddableAppWidget,
  type WidgetMeta,
} from "./HomeWidgets";
import {
  HOME_FIXED_BLOCKS,
  HOME_LAYOUT_KEY,
  HOME_WIDGETS_V1_KEY,
  appIdOfBlock,
  appWidgetBlockId,
  appWidgetSpan,
  customWidgetIdeas,
  homeLayoutReducer,
  isAppWidgetBlockId,
  isHomeFixedBlockId,
  migrateHomeLayout,
  normalizeHomeLayout,
  type HomeBlockId,
  type HomeLayoutAction,
} from "./homeLayout";
import { HOME_WIDGET_IDS, greeting, type HomeWidgetId } from "./homeModel";
import { usePersonFirstName } from "./useHomeInfo";
import { useHomeStarters } from "./useHomeStarters";
import { selectProjectsAcrossEnvironments, useStore } from "../../../store";
import { useSetupHome, type SetupHome } from "../../setup/useSetupHome";

const LAYOUT_SCHEMA = Schema.Array(Schema.String);

/** The layout (per device) and the Customize mode. */
export function useHomeLayout() {
  // Migration from the 0.0.81 widget list happens once, when there's no v2 layout yet.
  const [initial] = useState(() =>
    migrateHomeLayout(undefined, readStored(HOME_WIDGETS_V1_KEY) ?? undefined),
  );
  const [stored, setStored] = useLocalStorage<ReadonlyArray<string>, ReadonlyArray<string>>(
    HOME_LAYOUT_KEY,
    initial,
    LAYOUT_SCHEMA,
  );
  const blocks = useMemo(() => normalizeHomeLayout(stored), [stored]);
  const dispatch = useCallback(
    (action: HomeLayoutAction) =>
      setStored((previous) => homeLayoutReducer(normalizeHomeLayout(previous), action)),
    [setStored],
  );
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  return { blocks, dispatch, editing, setEditing, adding, setAdding };
}

function readStored(key: string): ReadonlyArray<string> | null {
  try {
    return getLocalStorageItem(key, LAYOUT_SCHEMA);
  } catch {
    return null;
  }
}

export type HomeLayout = ReturnType<typeof useHomeLayout>;

function appManifestId(app: UnoMachineApp): string | null {
  return app.source === "manifest" && app.id.startsWith("manifest:")
    ? app.id.slice("manifest:".length)
    : null;
}

export function HomeStart({
  environmentId,
  layout,
  computer,
  notices,
  builtIns,
  tiles,
  machineApps,
  appsLoading,
  onOpenTile,
  onTileDetails,
  hiddenApps,
  unhidingId,
  onUnhide,
  onStartTask,
  onAskUno,
}: {
  environmentId: EnvironmentId | null;
  layout: HomeLayout;
  computer: HomeComputer | null;
  /** Account / linking notices, the "your Uno computers" picker, errors. */
  notices: ReactNode;
  builtIns: BuiltInPrograms;
  tiles: ReadonlyArray<ProgramTile>;
  /** This computer's apps as the daemon reports them (widgets come from their manifests). */
  machineApps: ReadonlyArray<UnoMachineApp>;
  appsLoading: boolean;
  onOpenTile: (tile: ProgramTile) => void;
  onTileDetails: (tile: ProgramTile) => void;
  /** Found programs hidden from Home, listed under the Apps widget with "Show on Home". */
  hiddenApps: ReadonlyArray<UnoMachineApp>;
  unhidingId: string | null;
  onUnhide: (appId: string) => void;
  onStartTask: (prompt: string, options: HomeStartOptions) => Promise<void>;
  /** A new chat with `prompt` typed in, not sent. */
  onAskUno: (prompt: string) => Promise<void>;
}) {
  const { threads, now } = useHomeThreads();
  const firstName = usePersonFirstName(environmentId);
  const homeStarters = useHomeStarters({ environmentId, threads, now, tiles });
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const setupProgress = useSetupProgress();
  const setupHome = useSetupHome({
    projectHasChats: (cwd) => {
      const ids = new Set(
        projects.filter((project) => project.cwd === cwd).map((project) => project.id),
      );
      return threads.some((thread) => ids.has(thread.projectId));
    },
  });
  // A goal-first newcomer gets the goal buttons instead of suggestion chips.
  const goalFirst = goalState(setupProgress).goal !== null;
  const starters = goalFirst
    ? []
    : setupHome.starters.length > 0
      ? setupHome.starters
      : homeStarters;
  useGoalWatcher({ threads, machineApps });

  const widgetApps = useMemo(() => {
    const out = new Map<string, UnoMachineApp>();
    for (const app of machineApps) {
      const id = appManifestId(app);
      if (id && app.widget) out.set(id, app);
    }
    return out;
  }, [machineApps]);

  const available = useMemo<HomeBlockId[]>(
    () => [
      ...HOME_FIXED_BLOCKS,
      ...HOME_WIDGET_IDS.filter(
        (id) => (id !== "sites" || accountReachable()) && (id !== "computer" || computer !== null),
      ),
    ],
    [computer],
  );
  const shown = layout.blocks.filter((id) =>
    isAppWidgetBlockId(id) ? widgetApps.has(appIdOfBlock(id)) : available.includes(id),
  );
  const appWidgets = useMemo<AddableAppWidget[]>(
    () =>
      [...widgetApps.entries()].map(([id, app]) => ({
        id: appWidgetBlockId(id),
        name: app.name,
        icon: app.icon,
        iconImage: app.iconImage,
        title: app.widget?.title ?? app.name,
      })),
    [widgetApps],
  );
  const ideas = useMemo(
    () =>
      customWidgetIdeas(
        // The person's own apps (built here, from the App Store, containers they
        // started) — not the computer's services.
        tiles.filter((tile) => programRemoval(tile) !== null).map((tile) => tile.name),
      ),
    [tiles],
  );

  const metaOf = (id: HomeBlockId): WidgetMeta => {
    if (isHomeFixedBlockId(id)) return HOME_FIXED_BLOCK_META[id];
    if (isAppWidgetBlockId(id)) {
      const app = widgetApps.get(appIdOfBlock(id));
      return {
        title: app?.widget?.title ?? app?.name ?? "App widget",
        description: app ? `A widget of ${app.name}` : "",
        icon: app?.icon ? <span className="text-[13px] leading-none">{app.icon}</span> : null,
        span: appWidgetSpan(app?.widget?.size ?? "medium"),
      };
    }
    // A project just set up names the Files widget (its material is inside).
    if (id === "files" && setupHome.fresh && setupHome.project && !goalFirst) {
      return { ...HOME_WIDGETS.files, title: setupHome.project.name };
    }
    return HOME_WIDGETS[id];
  };

  const renderWidget = (id: HomeWidgetId): { body: ReactNode; action?: ReactNode } => {
    switch (id) {
      case "files":
        return {
          body: (
            <FilesWidget
              environmentId={environmentId}
              folder={setupHome.fresh && !goalFirst ? setupHome.project : null}
            />
          ),
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

  const render = (id: HomeBlockId): { body: ReactNode; action?: ReactNode } => {
    if (isAppWidgetBlockId(id)) {
      const app = widgetApps.get(appIdOfBlock(id));
      return app
        ? { body: <HomeAppWidget app={app} />, action: <HomeAppWidgetOpen app={app} /> }
        : { body: null };
    }
    switch (id) {
      case "greeting":
        return {
          body: (
            <div>
              <h1 className="text-[28px] font-semibold tracking-tight" data-testid="home-greeting">
                {greeting(new Date(now).getHours())}
                {firstName ? `, ${firstName}` : null}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground" data-testid="home-subtitle">
                {setupHome.project ? (
                  <>
                    Working on{" "}
                    <b className="font-medium text-foreground">{setupHome.project.name}</b>. What
                    should we do?
                  </>
                ) : (
                  "What should we work on?"
                )}
              </p>
            </div>
          ),
        };
      case "composer":
        return {
          body: (
            <div className="flex flex-col gap-4">
              <HomeComposer
                environmentId={environmentId}
                starters={starters}
                defaultFolder={setupHome.project}
                onStart={onStartTask}
              />
              <HomeGoalButtons />
              <NeedsYouPill threads={threads} now={now} />
              <HomeNextStep
                onStartTask={(prompt, folder) =>
                  void onStartTask(prompt, {
                    folder,
                    modelSelection: null,
                    runtimeMode: DEFAULT_RUNTIME_MODE,
                  })
                }
                onAskUno={(prompt) => void onAskUno(prompt)}
              />
              <HomeUnoEntry />
            </div>
          ),
        };
      case "continue":
        return { body: <ContinueCards threads={threads} now={now} /> };
      default:
        return renderWidget(id);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 pt-6 pb-16 sm:pt-12">
      {notices}
      {setupHome.banner ? <SetupDoneBanner setup={setupHome} /> : null}

      {layout.editing ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/50 px-3 py-2"
          data-testid="home-customize-bar"
        >
          <p className="mr-auto text-xs text-muted-foreground">
            Drag blocks to rearrange, × to hide. The composer can move but stays.
          </p>
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
        </div>
      ) : null}

      <HomeWidgetGrid
        blocks={shown}
        editing={layout.editing}
        dispatch={layout.dispatch}
        metaOf={metaOf}
        render={render}
      />

      {layout.editing ? null : (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => layout.setAdding(true)}
            className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
            Add a widget
          </button>
          <button
            type="button"
            onClick={() => layout.setEditing(true)}
            data-testid="home-customize"
            className="ml-auto flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PencilIcon className="size-3.5" />
            Customize
          </button>
        </div>
      )}

      <AddWidgetDialog
        open={layout.adding}
        onOpenChange={layout.setAdding}
        blocks={shown}
        available={available}
        metaOf={metaOf}
        appWidgets={appWidgets}
        customIdeas={ideas}
        onAskForWidget={(prompt) => void onAskUno(prompt)}
        dispatch={layout.dispatch}
      />
    </div>
  );
}

/** "Setup done" on Home after the guided setup, until closed. */
function SetupDoneBanner({ setup }: { setup: SetupHome }) {
  const navigate = useNavigate();
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/[0.05] px-4 py-3 text-sm"
      data-testid="home-setup-done"
    >
      <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1">
        Setup done.{" "}
        {setup.skippedCount > 0 ? (
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => void navigate({ to: "/setup", search: { step: "done" } })}
          >
            Finish {setup.skippedCount} skipped {setup.skippedCount === 1 ? "step" : "steps"}
          </button>
        ) : (
          "Change anything in Settings."
        )}
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={setup.closeBanner}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
