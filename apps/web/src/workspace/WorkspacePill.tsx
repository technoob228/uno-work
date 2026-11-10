/**
 * Workspace vision (10.11): the top-right of Home. Not "this computer and
 * +N" — the workspace: it is always on, and its computers are dots (on,
 * asleep, away). Click → the hardware.
 */
import { useNavigate } from "@tanstack/react-router";
import { LayersIcon } from "lucide-react";

import { useWorkspace } from "./api";
import { STATE_WORD } from "./model";
import { StateDot } from "./ui";

const MAX_DOTS = 5;

export function WorkspacePill() {
  const ws = useWorkspace().data ?? null;
  const navigate = useNavigate();
  if (!ws) return null;
  // Trouble first (away), then on, then asleep — as the computers chip does (02.11).
  const rank = { offline: 0, waking: 1, running: 2, asleep: 3 } as const;
  const computers = ws.computers.toSorted((a, b) => rank[a.state] - rank[b.state]);
  const shown = computers.slice(0, MAX_DOTS);
  return (
    <button
      type="button"
      onClick={() => void navigate({ to: "/workspace", search: { tab: "hardware" } })}
      className="flex h-8 shrink-0 items-center gap-2 rounded-full border border-border px-3 text-xs transition-colors hover:bg-accent"
      title={computers
        .map((computer) => `${computer.name}: ${STATE_WORD[computer.state]}`)
        .join("\n")}
      data-testid="ws-pill"
    >
      <LayersIcon className="size-3.5 text-primary" />
      <span className="font-medium">Workspace</span>
      <span className="flex items-center gap-1">
        {shown.map((computer) => (
          <StateDot key={computer.id} state={computer.state} />
        ))}
        {computers.length > MAX_DOTS ? (
          <span className="text-muted-foreground">+{computers.length - MAX_DOTS}</span>
        ) : null}
      </span>
    </button>
  );
}
