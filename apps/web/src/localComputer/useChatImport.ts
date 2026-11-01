/**
 * The chat import, for screens. Polled only while something is happening and a
 * screen is watching it, and never while the tab is hidden: the daemon does the
 * work on its own, so a closed tab costs nothing and loses nothing.
 */
import {
  SNOOZED_UNTIL_OPENED,
  type EnvironmentId,
  MessageId,
  type ImportedChatTool,
  type MyComputerChatHistory,
  type MyComputerImportStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import { ensureEnvironmentApi, readEnvironmentApi } from "../environmentApi";
import { newCommandId } from "../lib/utils";
import { selectSidebarThreadSummaryByRef, useStore } from "../store";
import type { ChatMessage } from "../types";

const IMPORT_KEY = ["my-computer", "import"] as const;
const WORKING_POLL_MS = 800;
/** The chat can't load until the computer is back: look again now and then. */
const OFFLINE_POLL_MS = 15_000;

/** "idle" too: a screen that watches has asked for something, the answer is on its way. */
const isUnsettled = (status: MyComputerImportStatus | undefined) =>
  status === undefined ||
  status.state === "idle" ||
  status.state === "scanning" ||
  status.state === "importing";

export function useImportStatus(
  environmentId: EnvironmentId | null,
  computerId: string | null,
  options: { readonly watch?: boolean } = {},
) {
  return useQuery({
    queryKey: [...IMPORT_KEY, environmentId, computerId],
    queryFn: () =>
      ensureEnvironmentApi(environmentId!).myComputer.importStatus({ computerId: computerId! }),
    enabled: environmentId !== null && computerId !== null,
    staleTime: 2_000,
    retry: false,
    refetchInterval: (query) =>
      options.watch === true && isUnsettled(query.state.data) ? WORKING_POLL_MS : false,
    refetchIntervalInBackground: false,
  });
}

/** Actions that answer with the new status: the screen shows it at once. */
export function useImportActions(environmentId: EnvironmentId | null, computerId: string | null) {
  const queryClient = useQueryClient();
  const act = useCallback(
    async (run: () => Promise<MyComputerImportStatus>) => {
      // A status read already on its way is older than this answer: left alone,
      // it would land after it and stop the screen's polling on the old state.
      const key = [...IMPORT_KEY, environmentId, computerId];
      await queryClient.cancelQueries({ queryKey: key });
      const status = await run();
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData(key, status);
      return status;
    },
    [computerId, environmentId, queryClient],
  );
  const api = useCallback(() => ensureEnvironmentApi(environmentId!).myComputer, [environmentId]);
  return {
    scan: useCallback(
      () => act(() => api().importScan({ computerId: computerId! })),
      [act, api, computerId],
    ),
    start: useCallback(
      (tools: ReadonlyArray<ImportedChatTool>) =>
        act(() => api().importStart({ computerId: computerId!, tools })),
      [act, api, computerId],
    ),
    decline: useCallback(
      () => act(() => api().importDecline({ computerId: computerId! })),
      [act, api, computerId],
    ),
  };
}

const NO_MESSAGES: ChatMessage[] = [];

/** The history as timeline messages: read-only, not part of the thread. */
export function importedChatMessages(history: MyComputerChatHistory | undefined): ChatMessage[] {
  if (history?.kind !== "ready") return NO_MESSAGES;
  return history.messages.map((message) => ({
    id: MessageId.make(message.id),
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    streaming: false,
  }));
}

/**
 * An imported chat on screen: its history from the computer, and out of Snoozed
 * for good once the person opened it.
 */
export function useImportedChat(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly imported: boolean;
}) {
  const { environmentId, threadId, imported } = input;
  const snoozedUntil = useStore((state) =>
    threadId === null
      ? null
      : selectSidebarThreadSummaryByRef(state, scopeThreadRef(environmentId, threadId))
          ?.snoozedUntil,
  );
  const query = useQuery({
    queryKey: [...IMPORT_KEY, "history", environmentId, threadId],
    queryFn: () =>
      ensureEnvironmentApi(environmentId).myComputer.chatHistory({ threadId: threadId! }),
    enabled: imported && threadId !== null,
    staleTime: 30_000,
    retry: false,
    refetchInterval: (state) => (state.state.data?.kind === "offline" ? OFFLINE_POLL_MS : false),
    refetchIntervalInBackground: false,
  });

  const woken = useRef<ThreadId | null>(null);
  useEffect(() => {
    if (threadId === null || !imported) return;
    if (snoozedUntil !== SNOOZED_UNTIL_OPENED || woken.current === threadId) return;
    woken.current = threadId;
    void readEnvironmentApi(environmentId)
      ?.orchestration.dispatchCommand({
        type: "thread.unsnooze",
        commandId: newCommandId(),
        threadId,
        reason: "user",
      })
      .catch(() => {
        // The chat is open either way; it stays in Snoozed until the next time.
        woken.current = null;
      });
  }, [environmentId, imported, snoozedUntil, threadId]);

  return query;
}
