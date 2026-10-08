/**
 * The "Home folder ▾" chip: where a new chat works. One click opens the recent
 * folders on this computer, "Another folder…" (the click-through folder
 * picker — no paths to type) and three ways to bring a folder in (08.10): New
 * folder…, Upload a folder…, Clone from GitHub… — the New project dialog's
 * steps, worded as folders; the new folder lands in `~/projects/<name>` and
 * the chat moves there with what was typed. Shared by Home's composer and a
 * new chat's header, so both offer the same choice. Nothing changes until the
 * person picks: the chat works in the home folder.
 */
import {
  isAssistantProjectId,
  type EnvironmentId,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderUpIcon,
  HouseIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "~/lib/utils";
import { folderDisplayName, useHomeFolderPath } from "../../hooks/useFolderChats";
import { normalizeProjectPathForComparison } from "../../lib/projectPaths";
import { type ChatFolderSource, openFolderForChat } from "../../navigation/newProjectStore";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { GitHubIcon } from "../Icons";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ChatInFolderDialog } from "./ChatInFolderDialog";

const MAX_FOLDERS = 8;

const BRING_FOLDER: ReadonlyArray<{
  source: ChatFolderSource;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { source: "empty", label: "New folder…", Icon: FolderPlusIcon },
  { source: "upload", label: "Upload a folder…", Icon: FolderUpIcon },
  { source: "github", label: "Clone from GitHub…", Icon: GitHubIcon },
];

export interface PickedFolder {
  readonly cwd: string;
  readonly name: string;
}

export function FolderChipMenu({
  environmentId,
  folder,
  onPick,
  className,
  testId,
}: {
  environmentId: EnvironmentId | null;
  /** The current folder; null = the home folder. */
  folder: PickedFolder | null;
  /**
   * null = the home folder. `projectRef` comes with a folder the chip has just
   * made (its project may not be in the store yet).
   */
  onPick: (folder: PickedFolder | null, projectRef?: ScopedProjectRef) => void | Promise<void>;
  className?: string;
  testId?: string;
}) {
  const [pickingFolder, setPickingFolder] = useState(false);
  const home = useHomeFolderPath(environmentId);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const folders = useMemo(() => {
    const homeKey = home ? normalizeProjectPathForComparison(home) : null;
    return projects
      .filter(
        (project) =>
          project.environmentId === environmentId &&
          !isAssistantProjectId(project.id) &&
          normalizeProjectPathForComparison(project.cwd) !== homeKey,
      )
      .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, MAX_FOLDERS);
  }, [environmentId, home, projects]);

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              className={cn("text-muted-foreground", className)}
              data-testid={testId}
              title={folder ? folder.cwd : (home ?? "Home folder")}
            >
              {folder ? <FolderIcon /> : <HouseIcon />}
              <span className="min-w-0 max-w-48 truncate">{folder ? folder.name : "Home folder"}</span>
              <ChevronDownIcon className="opacity-60" />
            </Button>
          }
        />
        <MenuPopup align="start">
          <MenuGroup>
            <MenuGroupLabel>Work in</MenuGroupLabel>
            <MenuItem onClick={() => onPick(null)}>
              <HouseIcon />
              Home folder
            </MenuItem>
            {folders.map((project) => (
              <MenuItem
                key={project.id}
                onClick={() => onPick({ cwd: project.cwd, name: project.name })}
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
          {BRING_FOLDER.map(({ source, label, Icon }) => (
            <MenuItem
              key={source}
              data-testid={`folder-chip-${source}`}
              onClick={() =>
                openFolderForChat(source, ({ name, folder: cwd, projectRef }) =>
                  onPick({ cwd, name }, projectRef),
                )
              }
            >
              <Icon />
              {label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <ChatInFolderDialog
        environmentId={environmentId}
        open={pickingFolder}
        onOpenChange={setPickingFolder}
        title="Work in a folder"
        description="Uno works with the files in the folder you pick."
        actionLabel={(name) => `Work in ${name}`}
        actionIcon={<FolderIcon />}
        onStart={async (cwd) => {
          onPick({ cwd, name: folderDisplayName(cwd) });
        }}
      />
    </>
  );
}
