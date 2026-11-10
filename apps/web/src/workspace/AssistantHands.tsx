/**
 * Workspace vision (10.11): an assistant lives in the workspace — its head
 * (memory, schedule, Telegram) in the account's cloud, always on — and works
 * with its hands: the computers it was given. Several at once, any kind; a
 * sleeping cloud one it may wake when a task needs it. Replaces "Where it
 * works" (one computer it lives on) on the assistant's page.
 */
import { CloudIcon } from "lucide-react";

import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import { useSetHands, useWorkspace } from "./api";
import { canWake, isUp, STATE_WORD, type WsAssistant, type WsComputer } from "./model";
import { ComputerGlyph, StateDot } from "./ui";

/** The assistant's record in the workspace, by its name (Uno, Mia, Bolt…). */
export function useWorkspaceAssistant(name: string): WsAssistant | null {
  const ws = useWorkspace().data;
  return (
    ws?.assistants.find((assistant) => assistant.name.toLowerCase() === name.toLowerCase()) ?? null
  );
}

function handNote(computer: WsComputer, wakes: boolean): string {
  if (isUp(computer)) return "On";
  if (computer.state === "waking") return "Waking";
  if (canWake(computer)) return wakes ? "Asleep · wakes it when needed" : "Asleep";
  return `${STATE_WORD[computer.state]} · waits for it`;
}

export function AssistantHands({ name }: { name: string }) {
  const ws = useWorkspace().data ?? null;
  const assistant = useWorkspaceAssistant(name);
  const setHands = useSetHands();
  if (!ws || !assistant) {
    return <p className="px-3 py-2.5 text-xs text-muted-foreground">Loading…</p>;
  }
  const save = (patch: Partial<Pick<WsAssistant, "hands" | "wakes">>) =>
    setHands.mutate({
      id: assistant.id,
      hands: patch.hands ?? assistant.hands,
      wakes: patch.wakes ?? assistant.wakes,
    });
  return (
    <div className="flex flex-col" data-testid="ws-assistant-hands">
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <CloudIcon className="size-4" />
        </span>
        <p className="min-w-0 flex-1 text-sm leading-snug">
          Lives in your workspace
          <span className="block text-xs text-muted-foreground">
            Memory{assistant.telegram ? " and Telegram" : ""} stay on when every computer sleeps
          </span>
        </p>
      </div>
      <ul className="border-t border-border/60">
        {ws.computers.map((computer) => {
          const on = assistant.hands.includes(computer.id);
          return (
            <li
              key={computer.id}
              className="flex h-11 items-center gap-2.5 border-b border-border/50 px-3 text-sm last:border-0"
              data-testid={`ws-hand-${computer.id}`}
            >
              <StateDot state={computer.state} />
              <ComputerGlyph computer={computer} />
              <span className={cn("min-w-0 truncate", !on && "text-muted-foreground")}>
                {computer.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {on ? handNote(computer, assistant.wakes) : ""}
              </span>
              <Switch
                checked={on}
                disabled={setHands.isPending}
                aria-label={`${assistant.name} may work on ${computer.name}`}
                onCheckedChange={(checked) =>
                  save({
                    hands: checked
                      ? [...assistant.hands, computer.id]
                      : assistant.hands.filter((id) => id !== computer.id),
                  })
                }
              />
            </li>
          );
        })}
      </ul>
      <label className="flex items-center gap-2.5 border-t border-border/60 px-3 py-2.5 text-sm">
        <span className="min-w-0 flex-1">Wake a sleeping computer when a task needs it</span>
        <Switch
          checked={assistant.wakes}
          disabled={setHands.isPending}
          onCheckedChange={(checked) => save({ wakes: checked })}
          data-testid="ws-hands-wakes"
        />
      </label>
    </div>
  );
}
