import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { newCommandId } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** The project a Rename asks about: one project entry on one computer. */
export interface ProjectRenameTarget {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly cwd: string;
  readonly environmentLabel: string | null;
}

/**
 * "Rename project", shared by both sidebars. Only the title the sidebar shows
 * changes: the folder on disk keeps its name.
 */
export function ProjectRenameDialog(props: {
  target: ProjectRenameTarget | null;
  onClose: () => void;
}) {
  const { target, onClose } = props;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* Keyed so the field starts from the project's current title each time. */}
      {target ? (
        <ProjectRenameForm
          key={`${target.environmentId}:${target.id}`}
          target={target}
          onClose={onClose}
        />
      ) : null}
    </Dialog>
  );
}

function ProjectRenameForm(props: { target: ProjectRenameTarget; onClose: () => void }) {
  const { target, onClose } = props;
  const [title, setTitle] = useState(target.name);

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      toastManager.add({ type: "warning", title: "Project title cannot be empty" });
      return;
    }
    if (trimmed === target.name) {
      onClose();
      return;
    }
    const api = readEnvironmentApi(target.environmentId);
    if (!api) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename project",
          description: "Project API unavailable.",
        }),
      );
      return;
    }
    try {
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: target.id,
        title: trimmed,
      });
      onClose();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  return (
    <DialogPopup className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Rename project</DialogTitle>
        <DialogDescription>
          Changes the name in the sidebar. The folder {target.cwd} keeps its name.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Project name</span>
          <Input
            aria-label="Project name"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        {target.environmentLabel ? (
          <p className="text-xs text-muted-foreground">Computer: {target.environmentLabel}</p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void submit()}>Save</Button>
      </DialogFooter>
    </DialogPopup>
  );
}
