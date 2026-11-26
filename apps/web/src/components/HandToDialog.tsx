/**
 * "Hand to…" (T63, Misha 24.11): pick who handles a chat — a coordinator (a
 * chat that runs chats), an assistant, another chat, or no one: its own
 * agent. The handler gets a brief and then this chat's Ready and questions;
 * approvals, secrets, payments and sign-ins stay with the person. Opened
 * from the chat menu and the chip above the composer (useHandToStore).
 * Chats and assistants on the person's other computers are listed per
 * computer (T63-C).
 */
import {
  BotIcon,
  CornerDownRightIcon,
  MessageCircleIcon,
  MonitorIcon,
  SearchIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { setThreadHandedTo, setThreadHandler } from "../agentsAccess";
import {
  HAND_TO_COPY,
  handToOptionKey,
  handToOptions,
  handlesChats,
  remoteHandToOptions,
  useHandToStore,
  type HandToOption,
} from "../handTo.logic";
import { useHandToComputers } from "../hooks/useHandToComputers";
import { cn } from "../lib/utils";
import { selectEnvironmentState, useStore } from "../store";
import type { SidebarThreadSummary } from "../types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const OWN_AGENT = "own-agent";

export function HandToDialog() {
  const target = useHandToStore((state) => state.target);
  const close = useHandToStore((state) => state.close);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const summaries = useStore((state) =>
    target ? selectEnvironmentState(state, target.environmentId).sidebarThreadSummaryById : null,
  );

  useEffect(() => {
    setQuery("");
    setPicked(null);
    setNote("");
  }, [target]);

  const threads = useMemo(() => Object.values(summaries ?? {}), [summaries]);
  const current = target ? (summaries?.[target.threadId] ?? null) : null;
  const options = useMemo(
    () =>
      target
        ? handToOptions({ threads, threadId: target.threadId, query })
        : { coordinators: [], assistants: [], others: [] },
    [query, target, threads],
  );
  // The person's other computers (T63-C).
  const computers = useHandToComputers(target?.environmentId ?? null);
  const summariesByComputer = useStore(
    useShallow((state) =>
      computers.map(
        (computer) =>
          selectEnvironmentState(state, computer.environmentId).sidebarThreadSummaryById,
      ),
    ),
  );
  const remote = useMemo(
    () =>
      target
        ? remoteHandToOptions({
            computers: computers.map((computer, index) => ({
              computer,
              threads: Object.values(
                summariesByComputer[index] ?? {},
              ) as ReadonlyArray<SidebarThreadSummary>,
            })),
            threads,
            threadId: target.threadId,
            query,
          })
        : [],
    [computers, query, summariesByComputer, target, threads],
  );
  const keepsHere =
    target !== null && computers.length > 0 && handlesChats(threads, target.threadId);
  const isCurrent = (option: HandToOption) =>
    option.threadId === current?.handler?.threadId &&
    (option.computer?.boxId ?? null) === (current?.handler?.computer?.boxId ?? null);
  const all = [
    ...options.coordinators,
    ...options.assistants,
    ...options.others,
    ...remote.flatMap((group) => group.options),
  ].filter((option) => !isCurrent(option));
  const fallback = all[0] ? handToOptionKey(all[0]) : OWN_AGENT;
  const chosenKey =
    picked !== null && (picked === OWN_AGENT || all.some((o) => handToOptionKey(o) === picked))
      ? picked
      : fallback;
  const chosen = all.find((option) => handToOptionKey(option) === chosenKey) ?? null;

  const handOver = async () => {
    if (!target) return;
    setBusy(true);
    try {
      let done: boolean;
      if (chosenKey === OWN_AGENT) {
        // Today's "Hand to agent": the chat carries on by itself.
        if (current?.handler) {
          await setThreadHandedTo({ ...target, handler: null });
        }
        done = await setThreadHandler({ ...target, controller: "agent" });
      } else if (chosen) {
        done = await setThreadHandedTo({
          ...target,
          handler: {
            threadId: chosen.threadId,
            kind: chosen.kind,
            title: chosen.title,
            note,
            computer: chosen.computer
              ? { boxId: chosen.computer.boxId, name: chosen.computer.name }
              : null,
          },
        });
      } else {
        done = false;
      }
      if (done) close();
    } finally {
      setBusy(false);
    }
  };

  const row = (key: string, title: string, detail: string, icon: ReactNode) => {
    const selected = chosenKey === key;
    return (
      <button
        key={key}
        type="button"
        aria-pressed={selected}
        data-testid="hand-to-option"
        onClick={() => setPicked(key)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring",
          selected ? "bg-accent" : "hover:bg-muted/60",
        )}
      >
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">{title}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
        </span>
        {selected ? (
          <span className="shrink-0 text-[11px] font-medium text-foreground">Selected</span>
        ) : null}
      </button>
    );
  };
  const group = (label: string, list: ReadonlyArray<HandToOption>, icon: ReactNode) => {
    const shown = list.filter((option) => !isCurrent(option));
    if (shown.length === 0) return null;
    return (
      <>
        <div className="px-2.5 pt-3 pb-1 text-[11px] font-medium text-muted-foreground">
          {label}
        </div>
        {shown.map((option) => row(handToOptionKey(option), option.title, option.detail, icon))}
      </>
    );
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup data-testid="hand-to-dialog" className="max-w-lg">
        <DialogHeader className="pb-3">
          <DialogTitle className="text-lg">Hand “{target?.title}” to…</DialogTitle>
          <DialogDescription>
            They get a brief, its Ready and its questions, and drive it. Approvals stay with you.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6">
          <label className="flex items-center gap-2 rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm">
            <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search chats and assistants"
              aria-label="Search chats and assistants"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>
        <div className="max-h-[min(30rem,50vh)] overflow-y-auto px-3.5 pb-2">
          {group(
            "Coordinators",
            options.coordinators,
            <UsersIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
          )}
          {group(
            "Assistants",
            options.assistants,
            <MessageCircleIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
          )}
          {group(
            "Other chats",
            options.others,
            <CornerDownRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
          )}
          {remote.map((entry) => (
            <div key={entry.computer.environmentId} data-testid="hand-to-computer">
              {group(
                HAND_TO_COPY.onComputer(entry.computer.name),
                entry.options,
                <MonitorIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
              )}
            </div>
          ))}
          {keepsHere ? (
            <div className="px-2.5 pt-3 pb-1 text-[11px] text-muted-foreground">
              {HAND_TO_COPY.handlesChatsNote}
            </div>
          ) : null}
          <div className="px-2.5 pt-3 pb-1 text-[11px] font-medium text-muted-foreground">
            No one
          </div>
          {row(
            OWN_AGENT,
            HAND_TO_COPY.ownAgent,
            HAND_TO_COPY.ownAgentDetail,
            <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
          )}
        </div>
        <div className="border-t border-border px-6 py-3">
          <input
            value={note}
            disabled={chosenKey === OWN_AGENT}
            onChange={(event) => setNote(event.target.value)}
            maxLength={1000}
            aria-label="What to tell them"
            placeholder="What to tell them (optional): e.g. “take it to launch, ping me only for money”"
            className="w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-[11px] text-muted-foreground">
            Leaves your list · Take back any time
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy || target === null}
              onClick={() => void handOver()}
              data-testid="hand-to-confirm"
            >
              Hand over
            </Button>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
