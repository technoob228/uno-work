/**
 * One way to switch the active machine, shared by the sidebar switcher and
 * "My machines". Makes the machine active and lands on its most relevant
 * chat; with no chat there, the index route shows that machine's own empty
 * state (`NoActiveThreadState`) instead of a project that lives elsewhere.
 * Projects are never moved between machines.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { pickThreadForEnvironmentSwitch } from "../components/Sidebar.logic";
import { selectSidebarThreadsForEnvironment, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { useSettings } from "./useSettings";
import { toastManager } from "../components/ui/toast";
import { machineLabel } from "../proto/protoPlace";
import { PROTO, readProtoMode } from "../proto/protoState";

export function useSwitchEnvironment() {
  const navigate = useNavigate();
  const setActiveEnvironmentId = useStore((state) => state.setActiveEnvironmentId);
  const sidebarThreadSortOrder = useSettings((settings) => settings.sidebarThreadSortOrder);

  return useCallback(
    (environmentId: EnvironmentId, options?: { readonly landing?: "computer" }) => {
      setActiveEnvironmentId(environmentId);
      // Sidebar prototype (w0115): land on Home and say what the switch changed.
      if (PROTO) {
        const name = machineLabel(environmentId);
        toastManager.add({
          type: "info",
          title: `Now on ${name}`,
          description:
            readProtoMode() === "one"
              ? `Chats, Needs you and Home now show ${name} only.`
              : `New chats start on ${name}. The list still shows every computer.`,
        });
        void navigate({ to: "/computer" });
        return;
      }
      // A cloud computer opens on its own home screen (programs, files, apps).
      if (options?.landing === "computer") {
        void navigate({ to: "/computer" });
        return;
      }
      const threads = selectSidebarThreadsForEnvironment(useStore.getState(), environmentId);
      const lastVisitedById = useUiStateStore.getState().threadLastVisitedAtById;
      const target = pickThreadForEnvironmentSwitch(
        threads,
        lastVisitedById,
        sidebarThreadSortOrder,
      );
      if (target) {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams({ environmentId, threadId: target.id }),
        });
        return;
      }
      void navigate({ to: "/" });
    },
    [navigate, setActiveEnvironmentId, sidebarThreadSortOrder],
  );
}
