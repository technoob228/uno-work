/**
 * Home's composer: type a task, press Enter, and a new chat starts on it — in
 * the home folder, or in a project folder picked from the chip. The chat
 * sends the task itself (the same send as Enter in a chat), so the model and
 * everything else come from the chat's usual defaults.
 */
import { isAssistantProjectId, type EnvironmentId } from "@t3tools/contracts";
import { ArrowUpIcon, ChevronDownIcon, FolderIcon, FolderOpenIcon, HouseIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "~/lib/utils";
import { selectProjectsAcrossEnvironments, useStore } from "../../../store";
import { Button } from "../../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import { Spinner } from "../../ui/spinner";
import { toastManager } from "../../ui/toast";
import { ChatInFolderDialog } from "../ChatInFolderDialog";

const SUGGESTIONS = [
  "Make me an app that…",
  "Publish a site from a folder",
  "Clean up my Downloads folder",
  "Explain what's running on this computer",
];

const MAX_FOLDERS = 8;

export function HomeComposer({
  environmentId,
  onStart,
}: {
  environmentId: EnvironmentId | null;
  /** Starts a chat in `folder` (the home folder when null) and sends `prompt`. */
  onStart: (prompt: string, folder: string | null) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [pickingFolder, setPickingFolder] = useState(false);
  const [folder, setFolder] = useState<{ cwd: string; name: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const folders = useMemo(
    () =>
      projects
        .filter(
          (project) => project.environmentId === environmentId && !isAssistantProjectId(project.id),
        )
        .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        .slice(0, MAX_FOLDERS),
    [environmentId, projects],
  );

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = async () => {
    const prompt = text.trim();
    if (!prompt || starting) {
      ref.current?.focus();
      return;
    }
    setStarting(true);
    try {
      await onStart(prompt, folder?.cwd ?? null);
      setText("");
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't start the chat",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="rounded-[20px] border bg-card shadow-xs/5 transition-colors has-focus-visible:border-ring/45">
        <textarea
          ref={ref}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder="What should Uno do? For example: build a sales report from the sheets in my cloud"
          aria-label="Give Uno a task"
          data-testid="home-composer"
          className="block min-h-[64px] w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
          <Menu>
            <MenuTrigger
              render={
                <Button size="xs" variant="ghost" className="text-muted-foreground">
                  {folder ? <FolderIcon /> : <HouseIcon />}
                  <span className="max-w-48 truncate">{folder ? folder.name : "Home folder"}</span>
                  <ChevronDownIcon className="opacity-60" />
                </Button>
              }
            />
            <MenuPopup align="start">
              <MenuGroup>
                <MenuGroupLabel>Work in</MenuGroupLabel>
                <MenuItem onClick={() => setFolder(null)}>
                  <HouseIcon />
                  Home folder
                </MenuItem>
                {folders.map((project) => (
                  <MenuItem
                    key={project.id}
                    onClick={() => setFolder({ cwd: project.cwd, name: project.name })}
                  >
                    <FolderIcon />
                    <span className="max-w-64 truncate">{project.name}</span>
                  </MenuItem>
                ))}
              </MenuGroup>
              <MenuSeparator />
              <MenuItem onClick={() => setPickingFolder(true)}>
                <FolderOpenIcon />
                Another folder…
              </MenuItem>
            </MenuPopup>
          </Menu>
          <button
            type="button"
            onClick={() => void submit()}
            aria-label="Start"
            disabled={starting}
            className={cn(
              "ml-auto flex size-8 items-center justify-center rounded-full transition-colors",
              text.trim()
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground",
            )}
          >
            {starting ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => {
              setText(suggestion);
              ref.current?.focus();
            }}
            className="rounded-full border border-border/70 bg-card/40 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <ChatInFolderDialog
        environmentId={environmentId}
        open={pickingFolder}
        onOpenChange={setPickingFolder}
        title="Work in a folder"
        description="Uno works with the files in the folder you pick."
        actionLabel={(name) => `Work in ${name}`}
        actionIcon={<FolderIcon />}
        onStart={async (cwd) => {
          setFolder({ cwd, name: cwd.replace(/\/+$/, "").split("/").pop() || cwd });
          ref.current?.focus();
        }}
      />
    </div>
  );
}
