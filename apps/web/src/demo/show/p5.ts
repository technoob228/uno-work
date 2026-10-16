// Point 5 of the w0138 mock: "Показать" puts the interface into the state to look at.
//
// The line over the chats with its title menu open (variant A): what the list
// shows — Projects / One list / Inbox, Group by computer, and in one list the
// project filter.
import { demoShow, useDemoStore } from "../demoFlag";
import { waitFor } from "./p4";

const TRIGGER = '[data-testid="sidebar-d-chats"] [data-testid="sidebar-d-view-trigger"]';

demoShow.p5 = async () => {
  useDemoStore.getState().setSwitch("sidebarViewSwitch", "header");
  if (!(await waitFor(() => document.querySelector(TRIGGER) !== null))) return;
  // Let the switch settle, then open the menu like a click on the title.
  await new Promise((resolve) => setTimeout(resolve, 150));
  document.querySelector<HTMLElement>(TRIGGER)?.click();
};
