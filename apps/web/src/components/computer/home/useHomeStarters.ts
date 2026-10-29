/**
 * Feeds `homeStarters` from what Home already fetches: how many projects the
 * person added, files changed lately in the home folder, the account's sites
 * (their queries share the cache with the Files / Sites widgets) — plus the
 * one extra request: concrete hints a model made from the end of the three most
 * recent chats (server-cached; see homeSuggestionsApi.ts).
 */
import { type EnvironmentId, isAssistantProjectId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { selectProjectsAcrossEnvironments, useStore } from "../../../store";
import { filesListQueryOptions } from "../../files/filesApi";
import { accountReachable, sitesQuery } from "../../myuno/myUnoQueries";
import { useInboxEntries } from "../../../inbox/inboxStore";
import { useFirstSnapshotPending } from "../../../lib/firstSnapshot";
import { useHeldUntilSettled } from "../../../lib/heldValue";
import {
  inboxSnoozedThreadIds,
  isContinueCandidate,
  recentHomeEntries,
  threadActivityAt,
  type HomeThread,
} from "./homeModel";
import { homeSuggestionsQueryOptions, type HomeSuggestionChat } from "./homeSuggestionsApi";
import { homeStarters, type HomeStarter, type StarterChatHint } from "./homeStarters";

/** How many recent chats the model reads (the server takes at most three). */
const HINT_CHATS = 3;

export function useHomeStarters(input: {
  environmentId: EnvironmentId | null;
  threads: ReadonlyArray<HomeThread>;
  now: number;
}): HomeStarter[] {
  const { environmentId, threads, now } = input;
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const homeListingQuery = useQuery(filesListQueryOptions(environmentId, null, false));
  const homeListing = homeListingQuery.data;
  const files = homeListing?.entries;
  const homePath = homeListing?.rootPath ?? null;
  const inbox = useInboxEntries();
  const sitesResult = useQuery({ ...sitesQuery(), enabled: accountReachable() });
  const sites = sitesResult.data?.sites;

  // The chats the model reads: the latest ones that were really talked in, by
  // the same bar as Continue (never settled or snoozed ones).
  const hintChats = useMemo(() => {
    const snoozedInInbox = inboxSnoozedThreadIds(inbox, now);
    return threads
      .filter(
        (thread) =>
          thread.environmentId === environmentId &&
          thread.latestUserMessageAt !== null &&
          isContinueCandidate(thread, now, snoozedInInbox),
      )
      .toSorted((a, b) => threadActivityAt(b) - threadActivityAt(a))
      .slice(0, HINT_CHATS);
  }, [environmentId, inbox, now, threads]);
  const suggestionChats = useMemo<HomeSuggestionChat[]>(
    () => hintChats.map((thread) => ({ id: thread.id, version: threadActivityAt(thread) })),
    [hintChats],
  );
  const suggestionsQuery = useQuery(homeSuggestionsQueryOptions(environmentId, suggestionChats));
  const suggestions = suggestionsQuery.data;
  // The chips come from four answers that land at different moments; until
  // they all did, keep the previous row (S6 29.10: it redrew 2–3 times).
  const snapshotPending = useFirstSnapshotPending();
  const settled =
    !snapshotPending &&
    !homeListingQuery.isLoading &&
    !sitesResult.isLoading &&
    !suggestionsQuery.isLoading;

  const live = useMemo(() => {
    const chatHints: StarterChatHint[] = (suggestions?.suggestions ?? []).flatMap((suggestion) => {
      const thread = hintChats.find((candidate) => candidate.id === suggestion.threadId);
      if (!thread) return [];
      const project = projects.find(
        (candidate) =>
          candidate.id === thread.projectId && candidate.environmentId === thread.environmentId,
      );
      return [
        {
          id: `${suggestion.threadId}:${suggestion.label}`.toLowerCase(),
          label: suggestion.label,
          prompt: suggestion.prompt,
          folder: project ? { cwd: project.cwd, name: project.name } : null,
        },
      ];
    });
    // The projects the person added: not the home folder, not an assistant's own folder.
    const home = homePath?.replace(/\/+$/, "") ?? null;
    const projectCount = projects.filter(
      (project) =>
        project.environmentId === environmentId &&
        !isAssistantProjectId(project.id) &&
        project.cwd.replace(/\/+$/, "") !== home,
    ).length;
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
      notifications,
      chatHints,
      projectCount,
      files: recentHomeEntries(files ?? [], 6).map((entry) => ({
        name: entry.name,
        isDirectory: entry.kind === "directory",
        modifiedAt: entry.modifiedAt,
      })),
      sites: (sites ?? []).map((site) => ({ name: site.customDomain ?? site.slug })),
    });
  }, [environmentId, files, hintChats, homePath, inbox, now, projects, sites, suggestions]);

  return useHeldUntilSettled({
    cacheKey: environmentId ? `home-starters:${environmentId}` : null,
    live,
    settled,
  });
}
