import { useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import LegacyThreadSidebar from "./LegacySidebar";
import ThreadSidebar from "./Sidebar";
import { isElectron } from "../env";
import { useFeatureFlag } from "../hooks/useFeatureFlags";
import { InboxListener } from "../inbox/InboxListener";
import { useNavLayout } from "../navigation/useNavLayout";
import { DesktopTabs } from "./DesktopTabs";
import { NavRail, RAIL_WIDTH } from "./sidebar/NavRail";
import { BrowserBridgeListener } from "./preview/BrowserBridgeListener";
import { FileBrowser } from "./preview/FileBrowser";
import { PreviewPane } from "./preview/PreviewPane";
import { cn } from "../lib/utils";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import {
  clearShortcutModifierState,
  syncShortcutModifierStateFromKeyboardEvent,
} from "../shortcutModifierState";

const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;
const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;
export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  // Labs "Sidebar (legacy)": the old project-grouped sidebar. Off (default)
  // is the flat chat list ported from upstream T3 Code's Sidebar v2.
  const legacySidebar = useFeatureFlag("legacySidebar");
  // Labs "Layout options": rail + panel, or tabs on top (desktop app).
  const layout = useNavLayout();
  const rail = layout === "rail";
  // В настройках правая панель предпросмотра не имеет смысла — прячем её
  // (webview внутри остаются жить, состояние вкладок сохраняется).
  const inSettings = useLocation({
    select: (location) => location.pathname.startsWith("/settings"),
  });

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowKeyUp = (event: KeyboardEvent) => {
      syncShortcutModifierStateFromKeyboardEvent(event);
    };
    const onWindowBlur = () => {
      clearShortcutModifierState();
    };

    window.addEventListener("keydown", onWindowKeyDown, true);
    window.addEventListener("keyup", onWindowKeyUp, true);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
      window.removeEventListener("keyup", onWindowKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, []);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        void navigate({ to: "/settings" });
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  // PreviewPaneProvider живёт выше, в __root: контекст нужен и командной
  // палитре (она рендерится вне этого layout-а).
  return (
    <>
      <SidebarProvider
        className="h-dvh! min-h-0!"
        defaultOpen
        style={{ ["--nav-rail-width" as string]: RAIL_WIDTH }}
      >
        {rail ? <NavRail isElectron={isElectron} /> : null}
        <Sidebar
          side="left"
          collapsible="offcanvas"
          className={cn(
            "border-r border-border bg-card text-foreground",
            // The panel sits right of the rail; folded, it is gone (the rail stays).
            rail && "left-(--nav-rail-width) group-data-[collapsible=offcanvas]:invisible",
          )}
          resizable={{
            minWidth: THREAD_SIDEBAR_MIN_WIDTH,
            shouldAcceptWidth: ({ nextWidth, wrapper }) =>
              wrapper.clientWidth - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
            storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
          }}
        >
          {legacySidebar ? <LegacyThreadSidebar /> : <ThreadSidebar />}
          <SidebarRail />
        </Sidebar>
        {layout === "tabs" && !inSettings ? (
          <div className="flex h-dvh min-w-0 flex-1 flex-col">
            <DesktopTabs />
            <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
          </div>
        ) : (
          children
        )}
        <PreviewPane suppressed={inSettings} />
        {/* Inside the provider: opening an item may close the phone sidebar. */}
        <InboxListener />
      </SidebarProvider>
      <FileBrowser />
      <BrowserBridgeListener />
    </>
  );
}
