/**
 * "Memory · 14" in the header of Uno's chat (sidebar D): what Uno remembers
 * about the person — its NOTES.md, read-only here. Uno changes it itself when
 * told "remember that …" or "forget …".
 */
import { ASSISTANT_PROJECT_ID, type EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { NotebookIcon } from "lucide-react";
import { useState } from "react";

import { countMemoryEntries } from "../../assistant/assistantChat.logic";
import { readAssistantFile } from "../../lib/managerApi";
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
      try {
        const file = await readAssistantFile({
          environmentId,
          projectId: ASSISTANT_PROJECT_ID,
          name: "NOTES.md",
        });
        return file.content;
      } catch {
        return ""; // no assistant yet, or an older computer
      }
    },
    staleTime: open ? 0 : 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const text = (notes.data ?? "").trim();
  const count = countMemoryEntries(text);
  const body = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim();

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
          {body.length > 0 ? (
            <div className="max-h-64 overflow-y-auto rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap text-foreground/90">
              {body}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Nothing yet. Tell Uno what to keep in mind: “Remember that the shop opens at 9”.
            </p>
          )}
          <p className="text-[11px] leading-snug text-muted-foreground">
            Uno keeps these notes itself. Say “remember that …” or “forget …” to change them.
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
