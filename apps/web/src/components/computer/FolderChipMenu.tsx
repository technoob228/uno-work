/**
 * The "Home folder ▾" chip: where a new chat works. One click opens the recent
 * folders on this computer and "Another folder…" (the click-through folder
 * picker — no paths to type). Shared by Home's composer and a new chat's
 * header, so both offer the same choice.
 */
import { isAssistantProjectId, type EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, FolderIcon, FolderOpenIcon, HouseIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "~/lib/utils";
import { folderDisplayName, useHomeFolderPath } from "../../hooks/useFolderChats";
import { normalizeProjectPathForComparison } from "../../lib/projectPaths";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
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
  /** null = the home folder. */
  onPick: (folder: PickedFolder | null) => void;
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
              <span className="max-w-48 truncate">{folder ? folder.name : "Home folder"}</span>
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
