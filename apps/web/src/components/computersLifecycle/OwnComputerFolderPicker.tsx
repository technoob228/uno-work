/**
 * The folder chip of a new chat "on MacBook" (one of the person's own computers
 * used as a full computer): the projects found on it (`computers.workScan`) and
 * its home folder. A pick becomes a project of the cloud computer that stands
 * for that folder (`computers.openFolder`); the chat runs in the cloud, its
 * commands and files on the computer.
 */
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, FolderIcon, HomeIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";

import { errorText } from "../../computersLifecycle/useComputers";
import { useComputerWork } from "../../computersLifecycle/useComputerWork";
import { ensureEnvironmentApi } from "../../environmentApi";
import type { PickedFolder } from "../computer/FolderChipMenu";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

/** A folder on the computer as a project of the cloud computer. */
export async function openOwnComputerFolder(input: {
  readonly hostId: EnvironmentId;
  readonly computerId: string;
  /** Absolute on the computer, or "~". */
  readonly path: string;
}): Promise<PickedFolder & { readonly projectId: ProjectId }> {
  const opened = await ensureEnvironmentApi(input.hostId).computers.openFolder({
    computerId: input.computerId,
    path: input.path,
  });
  return { cwd: opened.workspaceRoot, name: opened.title, projectId: opened.projectId };
}

export function OwnComputerFolderPicker({
  hostId,
  computerId,
  folder,
  onPick,
  testId = "home-folder-chip",
}: {
  hostId: EnvironmentId;
  computerId: string;
  folder: PickedFolder | null;
  onPick: (folder: PickedFolder & { readonly projectId: ProjectId }) => void | Promise<void>;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const work = useComputerWork(open ? computerId : null, { scan: open });
  const projects = work.status?.scan.projects ?? [];
  const scanning = work.searching;
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const pick = async (path: string) => {
    setBusyPath(path);
    try {
      await onPick(await openOwnComputerFolder({ hostId, computerId, path }));
      setOpen(false);
    } catch (cause) {
      toastManager.add({ type: "error", title: errorText(cause, "Couldn’t open that folder.") });
    } finally {
      setBusyPath(null);
    }
  };
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            className="min-w-0 shrink text-muted-foreground"
            data-testid={testId}
          />
        }
      >
        <FolderIcon />
        <span className="min-w-0 max-w-36 truncate">{folder?.name ?? "Home folder"}</span>
        <ChevronDownIcon className="opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-60">
        <MenuItem
          closeOnClick={false}
          onClick={() => void pick("~")}
          data-testid="lc-own-folder-home"
        >
          <HomeIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">Home folder</span>
          {busyPath === "~" ? <Loader2Icon className="size-4 animate-spin" /> : null}
        </MenuItem>
        <MenuGroup>
          <MenuGroupLabel>Projects</MenuGroupLabel>
          {scanning && projects.length === 0 ? (
            <MenuItem disabled>
              <Loader2Icon className="size-4 shrink-0 animate-spin" />
              Looking in ~/projects…
            </MenuItem>
          ) : projects.length === 0 ? (
            <MenuItem disabled>No projects in ~/projects</MenuItem>
          ) : (
            projects.map((project) => (
              <MenuItem
                key={project.path}
                closeOnClick={false}
                onClick={() => void pick(project.path)}
                data-testid="lc-own-folder-option"
              >
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {busyPath === project.path ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : folder?.name === project.name ? (
                  <CheckIcon className="size-4 shrink-0" />
                ) : null}
              </MenuItem>
            ))
          )}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
