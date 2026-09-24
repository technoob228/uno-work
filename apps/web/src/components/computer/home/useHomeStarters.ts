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
import { useInboxEntries } from "../../../inbox/inboxStore";
import {
  inboxSnoozedThreadIds,
  isContinueCandidate,
  pickContinueItems,
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
  const inbox = useInboxEntries();
  const sites = useQuery({ ...sitesQuery(), enabled: accountReachable() }).data?.sites;

  return useMemo(() => {
    const snoozedInInbox = inboxSnoozedThreadIds(inbox, now);
    const chats: StarterChat[] = threads
      // Same bar as Continue: settled or Inbox-snoozed chats are never suggested.
      .filter(
        (thread) =>
          thread.environmentId === environmentId &&
          isContinueCandidate(thread, now, snoozedInInbox),
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
    const continueCards = pickContinueItems(threads, inbox, { now });
    const continueTitles = continueCards.flatMap((card) =>
      card.kind === "chat" ? [card.thread.title] : [],
    );
    // Notifications already on a Continue card are suggested too: the card
    // opens the app, the chip asks Uno to deal with it.
    const notifications = inbox
      .filter(
        (item) =>
          item.kind === "app" &&
          item.environmentId === environmentId &&
          item.readAt === null &&
          !(item.snoozedUntil && Date.parse(item.snoozedUntil) > now),
      )
      .slice(0, 3)
      .map((item) => ({
        id: item.id,
        source: item.source.name,
        title: item.title,
        body: item.body,
      }));
    return homeStarters({
      continueTitles,
      notifications,
      chats,
      apps,
      files: recentHomeEntries(files ?? [], 6).map((entry) => ({
        name: entry.name,
        isDirectory: entry.kind === "directory",
        modifiedAt: entry.modifiedAt,
      })),
      sites: (sites ?? []).map((site) => ({ name: site.customDomain ?? site.slug })),
    });
  }, [environmentId, files, inbox, now, projects, sites, threads, tiles]);
}
