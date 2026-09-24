/**
 * The prototype's window: the sidebar, whatever screen is open, the notes
 * panel on the right, dialogs, toasts, and the dock that switches variants.
 */
import type { CSSProperties } from "react";

import { TooltipProvider } from "~/components/ui/tooltip";
import { AssistantSheet } from "./parts/Assistant";
import { Toaster } from "./parts/bits";
import { NewProjectDialog, NewProjectPage } from "./parts/NewProject";
import { ChatScreen } from "./screens/ChatScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { InboxScreen } from "./screens/InboxScreen";
import { AppScreen, ProjectScreen, TelegramSettingsScreen } from "./screens/Misc";
import { Sidebar } from "./shell/Sidebar";
import { NotesPanel, VariantDock } from "./shell/VariantDock";
import { useProto } from "./store";

export function App() {
  const screen = useProto((s) => s.screen);
  const notesOpen = useProto((s) => s.notesOpen);

  return (
    <TooltipProvider>
      <div
        className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground"
        style={{ "--notes-w": notesOpen ? "340px" : "0px" } as CSSProperties}
      >
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col pb-16">
          {screen.kind === "home" ? (
            <HomeScreen />
          ) : screen.kind === "chat" ? (
            <ChatScreen key={screen.threadId} threadId={screen.threadId} />
          ) : screen.kind === "inbox" ? (
            <InboxScreen />
          ) : screen.kind === "app" ? (
            <AppScreen appId={screen.appId} />
          ) : screen.kind === "project" ? (
            <ProjectScreen projectId={screen.projectId} />
          ) : screen.kind === "new-project" ? (
            <NewProjectPage />
          ) : (
            <TelegramSettingsScreen />
          )}
        </main>
        {notesOpen ? <NotesPanel /> : null}
      </div>
      <NewProjectDialog />
      <AssistantSheet />
      <VariantDock />
      <Toaster />
    </TooltipProvider>
  );
}
