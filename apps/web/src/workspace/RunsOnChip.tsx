/**
 * Workspace vision (10.11): a chat lives in the workspace; each of its turns
 * runs on a computer. The chip says where the next one runs and lets you
 * send it elsewhere — a sleeping cloud computer wakes on send, a laptop that
 * is away can't be picked. The chat's terminal and files stay on its own
 * computer (the menu's last line).
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, LayersIcon, TerminalIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { useHomeLaunchers } from "../components/computer/useHomeLaunchers";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import { toastManager } from "../components/ui/toast";
import { cn } from "../lib/utils";
import { chatComputerQuery, useSetChatComputer, useWorkspace } from "./api";
import { canWake, isUp, nextTurnPlace, STATE_WORD } from "./model";
import { ComputerGlyph, StateDot } from "./ui";

export function RunsOnChip(props: {
  environmentId: EnvironmentId;
  threadId: string;
  compact?: boolean;
}) {
  const ws = useWorkspace().data ?? null;
  const picked = useQuery(chatComputerQuery(props.threadId)).data?.computer ?? null;
  const setComputer = useSetChatComputer(props.threadId);
  const launchers = useHomeLaunchers(props.environmentId);
  const navigate = useNavigate();
  if (!ws) return null;
  const own =
    ws.computers.find((computer) => computer.environmentId === props.environmentId) ?? null;
  const place = nextTurnPlace(ws, picked, own?.id ?? null);
  if (!place.computer) return null;
  const current = place.computer;
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className="flex h-7 max-w-64 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 text-xs transition-colors hover:bg-accent"
            aria-label={`Runs on ${current.name}. Change where the next message runs`}
            data-testid="ws-runs-on"
            data-computer={current.id}
          />
        }
      >
        <StateDot state={current.state} className="size-1.5" />
        <ComputerGlyph computer={current} className="size-3.5" />
        <span className="truncate">{props.compact ? current.name : `Runs on ${current.name}`}</span>
        {place.note && !props.compact ? (
          <span className="truncate text-muted-foreground">· {place.note}</span>
        ) : null}
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel>Next message runs on</MenuGroupLabel>
          {ws.computers.map((computer) => {
            const usable = isUp(computer) || canWake(computer) || computer.state === "waking";
            const note = isUp(computer)
              ? computer.id === own?.id
                ? "this chat's"
                : null
              : canWake(computer)
                ? "wakes on send"
                : STATE_WORD[computer.state];
            return (
              <MenuItem
                key={computer.id}
                disabled={!usable}
                onClick={() => {
                  if (computer.id === current.id) return;
                  setComputer.mutate(computer.id === own?.id ? null : computer.id, {
                    onSuccess: () =>
                      toastManager.add({
                        type: "success",
                        title: `Next message runs on ${computer.name}`,
                        description: canWake(computer) ? "It wakes when you send." : undefined,
                      }),
                  });
                }}
                data-testid={`ws-runs-on-${computer.id}`}
              >
                <StateDot state={computer.state} />
                <ComputerGlyph computer={computer} />
                <span className="min-w-0 flex-1 truncate">{computer.name}</span>
                {note ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{note}</span>
                ) : null}
                <CheckIcon
                  className={cn(
                    "size-3.5",
                    computer.id === current.id ? "opacity-100" : "opacity-0",
                  )}
                />
              </MenuItem>
            );
          })}
        </MenuGroup>
        <MenuSeparator />
        {own && isUp(own) ? (
          <MenuItem onClick={() => void launchers.openTerminal()} data-testid="ws-runs-on-terminal">
            <TerminalIcon />
            Terminal on {own.name}
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => void navigate({ to: "/workspace", search: { tab: "hardware" } })}>
          <LayersIcon />
          All hardware
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
