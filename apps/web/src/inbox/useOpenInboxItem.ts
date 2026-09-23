/**
 * "Open" on an Inbox item: the chat, the document (Word/Excel/PowerPoint in
 * Office, anything else in Files), the app inside Uno, or an address inside
 * Uno. Opening marks the item read. Items of another computer switch to that
 * computer first, so the file or app is looked up where it lives.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { machineAppsQueryOptions } from "../components/computer/computerQueries";
import { isBrowserOnMachine, machineAppOpenUrl } from "../components/computer/programModel";
import { dirname, fileKindOf } from "../components/files/fileTypes";
import { toastManager } from "../components/ui/toast";
import { useSidebar } from "../components/ui/sidebar";
import { useOpenApp } from "../navigation/useOpenApp";
import { useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { type InboxEntry, updateInbox } from "./inboxStore";

const OFFICE_KINDS = new Set(["document", "spreadsheet", "presentation"]);

export function joinAppPath(base: string, path: string | null): string {
  if (!path) return base;
  try {
    const url = new URL(base);
    const [pathname = "", search = ""] = path.split("?", 2);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
    if (search) url.search = search;
    return url.toString();
  } catch {
    return base;
  }
}

export function useOpenInboxItem() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { openHere } = useOpenApp();
  const { isMobile, setOpenMobile } = useSidebar();

  return useCallback(
    async (item: InboxEntry) => {
      if (item.readAt === null) {
        void updateInbox(item.environmentId, { action: "read", ids: [item.id] }).catch(
          () => undefined,
        );
      }
      const target = item.open;
      if (!target) return;
      if (isMobile) setOpenMobile(false);
      if (target.kind === "thread") {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams({
            environmentId: item.environmentId,
            threadId: target.threadId as never,
          }),
        });
        return;
      }
      // Files and apps are looked up on the item's own computer.
      const store = useStore.getState();
      if (store.activeEnvironmentId !== item.environmentId) {
        store.setActiveEnvironmentId(item.environmentId);
      }
      if (target.kind === "file") {
        const name = target.path.split("/").pop() ?? target.path;
        if (OFFICE_KINDS.has(fileKindOf(name))) {
          void navigate({ to: "/office", search: { path: target.path } });
        } else {
          void navigate({
            to: "/files",
            search: { path: dirname(target.path), file: target.path },
          });
        }
        return;
      }
      if (target.kind === "url") {
        openHere({ url: target.url, name: item.source.name, icon: item.source.icon });
        return;
      }
      const apps = await queryClient
        .fetchQuery(machineAppsQueryOptions(item.environmentId, true))
        .catch(() => null);
      const app = apps?.apps.find((entry) => entry.id === `manifest:${target.appId}`) ?? null;
      const base = app
        ? machineAppOpenUrl(app, isBrowserOnMachine(window.location.hostname))
        : null;
      if (!app || !base) {
        toastManager.add({
          type: "info",
          title: `${item.source.name} isn't running`,
          description: "Start it on Home, then open the notification again.",
        });
        return;
      }
      openHere({
        url: joinAppPath(base, target.path),
        name: app.name,
        icon: app.icon,
      });
    },
    [isMobile, navigate, openHere, queryClient, setOpenMobile],
  );
}
