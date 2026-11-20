/**
 * What each built-in block is called and does, for the edit frame and the
 * catalog (T55). Apps' widgets come from the apps themselves (manifest
 * `widget`), see useWidgetApps.
 */
import type { EnvironmentId, UnoMachineApp } from "@t3tools/contracts";
import { useQueries } from "@tanstack/react-query";
import {
  BotIcon,
  CloudIcon,
  FolderKanbanIcon,
  HouseIcon,
  InboxIcon,
  LayoutGridIcon,
  MessagesSquareIcon,
  PinIcon,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { machineAppsQueryOptions } from "../components/computer/computerQueries";
import { useSidebarDComputers } from "../components/sidebar/SidebarDComputers";
import { parseWidgetBlockId, widgetBlockId, type BuiltInBlockId } from "./layoutModel";

export interface BuiltInBlockInfo {
  readonly title: string;
  readonly hint: string;
  readonly icon: ReactNode;
}

export const BUILT_IN_INFO: Record<BuiltInBlockId, BuiltInBlockInfo> = {
  places: {
    title: "Places",
    hint: "Home, Files, Apps & sites and your pinned icons",
    icon: <HouseIcon />,
  },
  assistants: { title: "Assistants", hint: "Uno and your other assistants", icon: <BotIcon /> },
  "needs-you": {
    title: "Needs you",
    hint: "Approvals and questions from agents, answered right here",
    icon: <InboxIcon />,
  },
  pinned: { title: "Pinned", hint: "Chats, apps, files and links you pinned", icon: <PinIcon /> },
  chats: {
    title: "Chats",
    hint: "All your chats with filters — always in the sidebar",
    icon: <MessagesSquareIcon />,
  },
  projects: {
    title: "Projects",
    hint: "Your folders, one click to a new chat in one",
    icon: <FolderKanbanIcon />,
  },
  computers: {
    title: "Computers",
    hint: "Each computer, awake or asleep",
    icon: <CloudIcon />,
  },
  apps: {
    title: "Running apps",
    hint: "Apps and sites on your computers, with their status",
    icon: <LayoutGridIcon />,
  },
};

export interface WidgetApp {
  readonly blockId: ReturnType<typeof widgetBlockId>;
  readonly environmentId: EnvironmentId;
  readonly computer: string;
  readonly app: UnoMachineApp;
}

/** Every app with a widget on every connected computer. */
export function useWidgetApps(): ReadonlyArray<WidgetApp> {
  const computers = useSidebarDComputers();
  const connected = useMemo(
    () => computers.filter((computer) => computer.environmentId !== null),
    [computers],
  );
  return useQueries({
    queries: connected.map((computer) =>
      machineAppsQueryOptions(computer.environmentId as EnvironmentId),
    ),
    combine: (results) => {
      const out: WidgetApp[] = [];
      results.forEach((result, index) => {
        const computer = connected[index]!;
        for (const app of result.data?.apps ?? []) {
          if (!app.widget) continue;
          out.push({
            blockId: widgetBlockId(computer.environmentId!, app.id),
            environmentId: computer.environmentId as EnvironmentId,
            computer: computer.label,
            app,
          });
        }
      });
      return out;
    },
  });
}

/** The app a preset names (`pult`) among the person's widget apps: its computer, or null. */
export function findPresetApp(
  apps: ReadonlyArray<WidgetApp>,
  key: string,
): { readonly environmentId: string; readonly appId: string } | null {
  const hit = apps.find(
    (item) => item.app.id === key || item.app.id.endsWith(`:${key}`) || item.app.name === key,
  );
  return hit ? { environmentId: hit.environmentId, appId: hit.app.id } : null;
}

export function widgetAppOf(
  apps: ReadonlyArray<WidgetApp>,
  blockId: string,
): WidgetApp | null {
  const parsed = parseWidgetBlockId(blockId);
  if (!parsed) return null;
  return (
    apps.find(
      (item) => item.environmentId === parsed.environmentId && item.app.id === parsed.appId,
    ) ?? null
  );
}
