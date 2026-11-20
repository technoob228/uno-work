/**
 * Keeps "From your team" fresh: a long poll on `requests/inbox` while the app
 * is open and T51's requests are on for the account (team/teamStore.ts), and
 * one system notification per request that starts waiting. Mounted once,
 * next to the chat-requests listener. Asks nothing while the part is off.
 */
import { useEffect } from "react";

import { showSystemNotification } from "../inbox/systemNotifications";
import { useNavStore } from "../navigation/navStore";
import { loadInbox } from "./teamApi";
import { isCollabOff } from "./teamApi.logic";
import { requestHeadline } from "./team.logic";
import { absorbInbox, resetTeamInbox, useTeamInboxStore, useTeamParts } from "./teamStore";

const WAIT_SECONDS = 20;
const RETRY_MS = 15_000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export function TeamInboxListener() {
  const on = useTeamParts().requests;
  useEffect(() => {
    if (!on) {
      resetTeamInbox();
      return;
    }
    const life = { disposed: false };
    const run = async () => {
      let first = true;
      while (!life.disposed) {
        const started = Date.now();
        try {
          const page = await loadInbox(useTeamInboxStore.getState().rev, first ? 0 : WAIT_SECONDS);
          if (life.disposed) return;
          const fresh = absorbInbox(page.requests, page.rev);
          // What already waits when the app opens isn't news: Needs you shows it.
          if (!first) {
            for (const request of fresh) {
              if (request.kind === "session") continue;
              showSystemNotification({
                tag: `team-request:${request.id}`,
                kind: "agent.input",
                title: requestHeadline(request),
                body: request.gist || request.body.slice(0, 200) || null,
                viewingItsChat: false,
                onClick: () => useNavStore.getState().setSidebarMode("inbox"),
              });
            }
          }
          first = false;
          if (page.requests.length === 0 && Date.now() - started < 2_000) await sleep(5_000);
          if (document.visibilityState === "hidden") await sleep(10_000);
        } catch (error) {
          if (life.disposed || isCollabOff(error)) return;
          await sleep(RETRY_MS);
        }
      }
    };
    void run();
    return () => {
      life.disposed = true;
    };
  }, [on]);
  return null;
}
