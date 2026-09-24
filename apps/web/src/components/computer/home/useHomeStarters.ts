/**
 * Feeds `homeStarters` from what Home already fetches: recent chats (with
 * their folders), this computer's apps, files changed lately in the home
 * folder, and the account's sites. No extra requests: the files and sites
 * queries share their cache with the Files / Sites widgets.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { selectProjectsAcrossEnvironments, useStore } from "../../../store";
import { filesListQueryOptions } from "../../files/filesApi";
import { accountReachable, sitesQuery } from "../../myuno/myUnoQueries";
import { programRemoval, type ProgramTile } from "../programModel";
import {
  isHomeVisibleThread,
  pickContinueThreads,
  recentHomeEntries,
  threadActivityAt,
  type HomeThread,
} from "./homeModel";
import { homeStarters, type HomeStarter, type StarterApp, type StarterChat } from "./homeStarters";

const MAX_CHATS = 8;

export function useHomeStarters(input: {
  environmentId: EnvironmentId | null;
  threads: ReadonlyArray<HomeThread>;
  now: number;
  tiles: ReadonlyArray<ProgramTile>;
}): HomeStarter[] {
  const { environmentId, threads, now, tiles } = input;
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const files = useQuery(filesListQueryOptions(environmentId, null, false)).data?.entries;
  const sites = useQuery({ ...sitesQuery(), enabled: accountReachable() }).data?.sites;

  return useMemo(() => {
    const chats: StarterChat[] = threads
      .filter(
        (thread) => thread.environmentId === environmentId && isHomeVisibleThread(thread, now),
      )
      .map((thread) => {
        const project = projects.find(
          (candidate) =>
            candidate.id === thread.projectId && candidate.environmentId === thread.environmentId,
        );
        return {
          title: thread.title,
          activityAt: threadActivityAt(thread),
          folder: project ? { cwd: project.cwd, name: project.name } : null,
        };
      })
      .toSorted((a, b) => b.activityAt - a.activityAt)
      .slice(0, MAX_CHATS);
    const apps: StarterApp[] = [];
    for (const tile of tiles) {
      const removal = programRemoval(tile);
      if (removal) apps.push({ name: tile.name, kind: removal.kind });
    }
    // Exactly the cards Continue shows (same input, same pick), so a starter
    // never repeats a card right below the composer.
    const continueTitles = pickContinueThreads(threads, { now }).map((thread) => thread.title);
    return homeStarters({
      continueTitles,
      chats,
      apps,
      files: recentHomeEntries(files ?? [], 6).map((entry) => ({
        name: entry.name,
        isDirectory: entry.kind === "directory",
        modifiedAt: entry.modifiedAt,
      })),
      sites: (sites ?? []).map((site) => ({ name: site.customDomain ?? site.slug })),
    });
  }, [environmentId, files, now, projects, sites, threads, tiles]);
}
