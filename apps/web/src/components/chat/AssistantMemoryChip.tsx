/**
 * "Memory · 14" in the header of Uno's chat (sidebar D): what Uno remembers
 * about the person — its NOTES.md, one thing per row. "Forget this" takes a
 * single note out (decision 24 b, 03.10); adding and rewording stay with Uno
 * ("remember that …").
 */
import { ASSISTANT_PROJECT_ID, type EnvironmentId } from "@t3tools/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { NotebookIcon, XIcon } from "lucide-react";
import { useState } from "react";

import {
  countMemoryEntries,
  forgetMemoryEntry,
  memoryEntries,
  type MemoryEntry,
} from "../../assistant/assistantChat.logic";
import { readAssistantFile, writeAssistantFile } from "../../lib/managerApi";
import { toastManager } from "../ui/toast";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function AssistantMemoryChip({
  environmentId,
  onOpenSettings,
}: {
  environmentId: EnvironmentId;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const notes = useQuery({
    queryKey: ["uno-assistant", "memory", environmentId],
    queryFn: async () => {
      const file = await readAssistantFile({
        environmentId,
        projectId: ASSISTANT_PROJECT_ID,
        name: "NOTES.md",
      });
      return file.content;
    },
    staleTime: open ? 0 : 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const text = (notes.data ?? "").trim();
  const count = countMemoryEntries(text);
  const entries = memoryEntries(notes.data ?? "");
  const forget = useMutation({
    mutationFn: async (entry: MemoryEntry) => {
      const current = notes.data ?? "";
      return writeAssistantFile({
        environmentId,
        projectId: ASSISTANT_PROJECT_ID,
        name: "NOTES.md",
        content: forgetMemoryEntry(current, entry),
        // Uno may be writing its notes right now: the server merges on top.
        base: current,
      });
    },
    onSuccess: () => void notes.refetch(),
    onError: () =>
      toastManager.add({ type: "error", title: "Couldn't forget that. Try again in a moment." }),
  });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void notes.refetch();
      }}
    >
      <PopoverTrigger
        data-testid="uno-memory"
        title="What Uno remembers about you"
        className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-input px-2 text-xs font-medium text-foreground shadow-xs/5 hover:bg-accent sm:h-6"
      >
        <NotebookIcon className="size-3.5 text-muted-foreground" />
        <span className="hidden @2xl/header-actions:inline">Memory</span>
        {count > 0 ? (
          <span className="text-muted-foreground tabular-nums" data-testid="uno-memory-count">
            <span className="hidden @2xl/header-actions:inline">· </span>
            {count}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[22rem]" data-testid="uno-memory-popup">
        <div className="flex flex-col gap-2">
          <div className="text-sm font-semibold">What Uno remembers</div>
          {notes.isError && notes.data === undefined ? (
            <p className="text-xs text-muted-foreground" data-testid="uno-memory-unavailable">
              Couldn't read Uno's notes right now. Try again in a moment.
            </p>
          ) : entries.length > 0 ? (
            <ul
              className="max-h-64 overflow-y-auto rounded-md border border-border/70 bg-muted/20 py-1 text-xs leading-relaxed text-foreground/90"
              data-testid="uno-memory-list"
            >
              {entries.map((entry) => (
                <li
                  key={`${entry.start}:${entry.text}`}
                  className="group flex items-start gap-2 px-2.5 py-1 hover:bg-accent/40"
                  data-testid="uno-memory-entry"
                >
                  <span className="min-w-0 flex-1 break-words">{entry.text}</span>
                  <button
                    type="button"
                    aria-label={`Forget this: ${entry.text}`}
                    title="Forget this"
                    disabled={forget.isPending}
                    onClick={() => forget.mutate(entry)}
                    data-testid="uno-memory-forget"
                    className="mt-0.5 shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-default disabled:opacity-30"
                  >
                    <XIcon className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              Nothing yet. Tell Uno what to keep in mind: “Remember that the shop opens at 9”.
            </p>
          )}
          <p className="text-[11px] leading-snug text-muted-foreground">
            Uno keeps these notes itself. Say “remember that …” to add one; the ✕ makes Uno forget
            it.
          </p>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
            data-testid="uno-memory-settings"
            className="self-start text-[11px] font-medium text-primary hover:underline"
          >
            Uno settings: Telegram, Slack, what it does
          </button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
