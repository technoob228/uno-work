/**
 * ↗ on a file in the panel's path bar (w0138, point 8). Desktop app: a small
 * menu — "Open in <editor>" and "Share with a link…". Work on a cloud
 * computer: ↗ is the Share button. Both open the same share popover under ↗
 * (FileSharePopover); a file on the laptop is shared as a Cloud storage copy,
 * a file on a cloud computer gets a link from that computer.
 */
import { EDITORS, type EnvironmentId } from "@t3tools/contracts";
import { ExternalLinkIcon, LinkIcon, ShareIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useDemoDesktop } from "../../demo/demoFlag";
import { usePreferredEditor } from "../../editorPreferences";
import { isElectron } from "../../env";
import { isPrimaryEnvironmentId } from "../../environments/http/target";
import { useServerAvailableEditors } from "../../rpc/serverState";
import { useMachineLabels } from "../../hooks/useMachineRows";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { PreviewFile } from "./PreviewPaneContext";
import { FileSharePopover } from "./FileSharePopover";
import { planFileActions } from "./fileShare.logic";

const iconButton =
  "inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 data-popup-open:bg-accent data-popup-open:text-foreground";

export function FileOpenShareButton({
  file,
  environmentId,
  onOpenInEditor,
}: {
  file: PreviewFile;
  environmentId: EnvironmentId | null;
  onOpenInEditor: (path: string) => void;
}) {
  const demoDesktop = useDemoDesktop();
  const desktop = isElectron || demoDesktop;
  const envId = file.environmentId ?? environmentId;
  const onThisLaptop = envId !== null && isPrimaryEnvironmentId(envId);
  const plan = planFileActions({ desktop, onThisLaptop });
  const availableEditors = useServerAvailableEditors();
  const [editor] = usePreferredEditor(availableEditors);
  const editorName =
    EDITORS.find((candidate) => candidate.id === editor && candidate.id !== "file-manager")
      ?.label ?? "your editor";
  const machineLabels = useMachineLabels();
  const computerLabel = envId ? (machineLabels.get(envId) ?? null) : null;
  const computerName = onThisLaptop && desktop ? "This Mac" : (computerLabel ?? "This computer");

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const path = file.path ?? null;

  const trigger = plan.menu ? (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              ref={buttonRef}
              disabled={!path}
              aria-label="Open or share"
              data-testid="preview-open-share"
              className={iconButton}
            />
          }
        >
          <ExternalLinkIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Open or share</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="w-56" data-testid="preview-open-share-menu">
        <MenuItem onClick={() => path && onOpenInEditor(path)}>
          <SquareArrowOutUpRightIcon />
          Open in {editorName}
        </MenuItem>
        <MenuItem
          onClick={() => {
            // After the menu has closed and given focus back to ↗.
            window.setTimeout(() => setShareOpen(true), 0);
          }}
        >
          <LinkIcon />
          Share with a link…
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setShareOpen(true)}
            disabled={!path}
            aria-label="Share"
            data-testid="preview-share"
            data-popup-open={shareOpen ? "" : undefined}
            className={iconButton}
          >
            <ShareIcon className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="bottom">Share with a link</TooltipPopup>
    </Tooltip>
  );

  return (
    <>
      {trigger}
      {path ? (
        <FileSharePopover
          open={shareOpen}
          onOpenChange={setShareOpen}
          anchor={buttonRef.current}
          environmentId={envId}
          path={path}
          name={file.name}
          route={plan.share}
          computerName={computerName}
        />
      ) : null}
    </>
  );
}
