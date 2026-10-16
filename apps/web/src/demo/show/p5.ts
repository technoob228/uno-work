// Point 5 of the w0138 mock: "Показать" puts the interface into the state to look at.
//
// p5 — the line over the chats with its title menu open, in the variant picked
// in the panel (A: the ways to group; B: "Change in Settings"), Projects,
// Computers; Add a project and New chat on the right.
// p5b — "Filter and grouping": grouped Computer → Project, only landing (one
// project on the MacBook and uno-product), the menu open.
import { useSidebarDViewMenu } from "../../components/sidebar/SidebarDChatsBar";
import type { SidebarGroupLevel } from "../../components/sidebar/sidebarDView.logic";
import { demoHooks, demoShow } from "../demoFlag";
import { waitFor } from "./p4";

interface SidebarDHandle {
  readonly setLevels: (levels: ReadonlyArray<SidebarGroupLevel>) => void;
  readonly setProjectPicks: (picked: ReadonlyArray<string> | null) => void;
  readonly setComputerPicks: (picked: ReadonlyArray<string> | null) => void;
  readonly projectKeyByName: (name: string) => string | null;
}

const TRIGGER = '[data-testid="sidebar-d-chats"] [data-testid="sidebar-d-view-trigger"]';
const handle = () => demoHooks.sidebarD as SidebarDHandle | undefined;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function openMenu() {
  if (!(await waitFor(() => document.querySelector(TRIGGER) !== null && handle() !== undefined))) {
    return false;
  }
  useSidebarDViewMenu.getState().setOpen(false);
  await pause(120);
  return true;
}

demoShow.p5 = async () => {
  if (!(await openMenu())) return;
  useSidebarDViewMenu.getState().setOpen(true);
};

demoShow.p5b = async () => {
  if (!(await openMenu())) return;
  const sidebar = handle()!;
  sidebar.setLevels(["computer", "project"]);
  sidebar.setComputerPicks(null);
  if (!(await waitFor(() => handle()?.projectKeyByName("landing") != null))) return;
  sidebar.setProjectPicks([handle()!.projectKeyByName("landing")!]);
  await pause(200);
  useSidebarDViewMenu.getState().setOpen(true);
};
