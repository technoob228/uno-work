/**
 * Sidebar D's shared state: expanded or collapsed (this device's choice), a
 * narrow window showing the rail on its own, and the slide-out chats panel
 * the rail and the sidebar both drive. See sidebarD.logic.ts for the rules.
 */
import { useCallback, useEffect } from "react";
import { create } from "zustand";

import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { useIsMobile, useMediaQuery } from "../../hooks/useMediaQuery";
import { useNavLayout } from "../../navigation/useNavLayout";
import { HoverPanelController } from "./sidebarD.hover";
import { SIDEBAR_D_COLLAPSED_KEY, SIDEBAR_D_NARROW_PX, sidebarDRailShown } from "./sidebarD.logic";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_D_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_D_COLLAPSED_KEY, String(value));
  } catch {
    // private mode: the choice lasts for the session
  }
}

interface SidebarDState {
  /** The person chose the rail on this device. */
  readonly collapsedChoice: boolean;
  /** Opened by hand while the window is narrow (not remembered). */
  readonly openedWhileNarrow: boolean;
  /** The chats panel slid out of the rail. */
  readonly panelOpen: boolean;
  readonly setCollapsedChoice: (value: boolean) => void;
  readonly setOpenedWhileNarrow: (value: boolean) => void;
}

export const useSidebarDStore = create<SidebarDState>((set) => ({
  collapsedChoice: typeof window === "undefined" ? false : readCollapsed(),
  openedWhileNarrow: false,
  panelOpen: false,
  setCollapsedChoice: (collapsedChoice) => {
    writeCollapsed(collapsedChoice);
    set({ collapsedChoice });
  },
  setOpenedWhileNarrow: (openedWhileNarrow) => set({ openedWhileNarrow }),
}));

/** One panel for the window: the rail's hover and the panel's own hover share it. */
export const sidebarDPanel = new HoverPanelController((open) =>
  useSidebarDStore.setState({ panelOpen: open }),
);

/**
 * While the rail's chats panel is out: a click into the page or Esc hides it.
 *
 * Esc is caught in the capture phase. The pointer usually still rests on the
 * rail icon that opened the panel, its tooltip is open, and an open tooltip
 * takes Esc for itself and stops it there: a listener in the bubble phase
 * never heard the key (validator, 0.0.105: "Esc doesn't close the panel
 * while the pointer is on the icon").
 */
export function useSidebarDPanelDismiss(input: {
  readonly active: boolean;
  readonly panelRef: { readonly current: HTMLElement | null };
}): void {
  const { active, panelRef } = input;
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest('[data-testid="sidebar-rail"]')) return;
      // Menus and dialogs opened from the panel (a chat's menu) live in portals.
      if (target.closest('[role="menu"], [role="dialog"], [data-slot="popover-popup"]')) return;
      sidebarDPanel.closeNow();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") sidebarDPanel.closeNow();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [active, panelRef]);
}

export function useSidebarDNarrow(): boolean {
  return useMediaQuery({ max: SIDEBAR_D_NARROW_PX });
}

/**
 * For the layout (SidebarProvider's controlled `open`): whether the rail
 * shows, and what "open"/"close" (⌘B, the expand and collapse buttons) do
 * to the person's choice.
 */
export function useSidebarDOpenState(input: {
  readonly enabled: boolean;
  readonly isMobile: boolean;
}) {
  const collapsedChoice = useSidebarDStore((state) => state.collapsedChoice);
  const openedWhileNarrow = useSidebarDStore((state) => state.openedWhileNarrow);
  const setCollapsedChoice = useSidebarDStore((state) => state.setCollapsedChoice);
  const setOpenedWhileNarrow = useSidebarDStore((state) => state.setOpenedWhileNarrow);
  const narrow = useSidebarDNarrow();
  const railShown =
    input.enabled &&
    sidebarDRailShown({ collapsedChoice, narrow, openedWhileNarrow, isMobile: input.isMobile });
  // Leaving a narrow window forgets the one-off "opened while narrow".
  useEffect(() => {
    if (!narrow && openedWhileNarrow) setOpenedWhileNarrow(false);
  }, [narrow, openedWhileNarrow, setOpenedWhileNarrow]);
  // The panel never outlives the rail.
  useEffect(() => {
    if (!railShown) sidebarDPanel.closeNow();
  }, [railShown]);
  const setOpen = useCallback(
    (open: boolean) => {
      if (open) {
        if (collapsedChoice) setCollapsedChoice(false);
        if (narrow) setOpenedWhileNarrow(true);
        sidebarDPanel.closeNow();
      } else if (narrow && !collapsedChoice) {
        setOpenedWhileNarrow(false);
      } else {
        setCollapsedChoice(true);
      }
    },
    [collapsedChoice, narrow, setCollapsedChoice, setOpenedWhileNarrow],
  );
  return { railShown, setOpen };
}

/** Sidebar D is the standard sidebar; Labs' rail layout and legacy sidebar keep theirs. */
export function useSidebarDEnabled(): boolean {
  const legacySidebar = useFeatureFlag("legacySidebar");
  const layout = useNavLayout();
  return !legacySidebar && layout !== "rail";
}

/** The collapsed rail is on screen (headers then need no "show sidebar" button). */
export function useSidebarDRailVisible(): boolean {
  const enabled = useSidebarDEnabled();
  const isMobile = useIsMobile();
  return useSidebarDOpenState({ enabled, isMobile }).railShown;
}
