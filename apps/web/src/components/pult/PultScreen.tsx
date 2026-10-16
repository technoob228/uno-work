/**
 * The Pult as a screen in the middle (the second way to show it): the board
 * where Home is; a task opens its chat here and the task itself on the right.
 */
import { GaugeIcon } from "lucide-react";

import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { SidebarInset } from "../ui/sidebar";
import { PultView } from "./PultView";

export function PultScreen() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="drag-region flex h-[52px] shrink-0 items-center gap-1.5 border-b border-border px-2 sm:px-3 wco:h-[env(titlebar-area-height)]">
          <SidebarShowButton />
          <GaugeIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Пульт</span>
        </header>
        <div className="min-h-0 flex-1">
          <PultView layout="center" />
        </div>
      </div>
    </SidebarInset>
  );
}
