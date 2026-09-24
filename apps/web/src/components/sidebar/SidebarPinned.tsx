/**
 * Pinned — the few things a person comes back to, visible in every sidebar
 * mode: chats (pinned on the chat itself), apps, files, folders and links
 * (pinned into the computer's settings). A click opens the thing where it
 * belongs: an app inside Uno, a file in Files, a link in a new tab.
 */
import type { UnoPin } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  FileIcon,
  FolderIcon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { linkTitle, normalizeLinkInput } from "../../navigation/pins";
import { openInNewTab, useOpenApp } from "../../navigation/useOpenApp";
import { usePins } from "../../navigation/usePins";
import { ProgramIcon } from "../computer/ComputerPrograms";
import { dirname } from "../files/fileTypes";
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
import { useSidebar } from "../ui/sidebar";

export const SidebarPinned = memo(function SidebarPinned({
  pinnedChats,
  hasPinnedChats,
}: {
  /** Pinned chat rows, rendered by the chat list (they carry its behaviour). */
  pinnedChats: ReactNode;
  hasPinnedChats: boolean;
}) {
  const { pins, unpin, rename, pin } = usePins();
  const [linkOpen, setLinkOpen] = useState(false);
  const [renaming, setRenaming] = useState<UnoPin | null>(null);
  const empty = pins.length === 0 && !hasPinnedChats;

  return (
    <section aria-label="Pinned" className="flex flex-col gap-px">
      <div className="flex h-6 items-center justify-between pr-0.5 pl-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
          Pinned
        </span>
        <button
          type="button"
          aria-label="Pin a link"
          title="Pin a link"
          onClick={() => setLinkOpen(true)}
          className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground/70 hover:bg-sidebar-row-hover hover:text-foreground"
        >
          <PlusIcon className="size-3.5" />
        </button>
      </div>
      {empty ? (
        <p className="px-2 pb-1 text-[11px] leading-snug text-muted-foreground/60">
          Pin chats, apps, files and links to keep them one click away.
        </p>
      ) : null}
      {hasPinnedChats ? <ul className="flex flex-col gap-px">{pinnedChats}</ul> : null}
      {pins.length > 0 ? (
        <ul className="flex flex-col gap-px">
          {pins.map((item) => (
            <PinRow
              key={item.id}
              item={item}
              onUnpin={() => unpin(item.id)}
              onRename={() => setRenaming(item)}
            />
          ))}
        </ul>
      ) : null}

      <PinLinkDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        onPin={(url, title) => pin({ kind: "link", target: url, title, icon: null })}
      />
      <RenamePinDialog
        item={renaming}
        onClose={() => setRenaming(null)}
        onRename={(title) => {
          if (renaming) rename(renaming.id, title);
          setRenaming(null);
        }}
      />
    </section>
  );
});

export function PinIcon({ item }: { item: UnoPin }) {
  if (item.kind === "app") {
    return (
      <ProgramIcon
        name={item.title}
        icon={item.icon ?? null}
        iconImage={null}
        className="size-5 rounded-md text-[13px] leading-none shadow-none ring-0"
      />
    );
  }
  const Icon = item.kind === "folder" ? FolderIcon : item.kind === "file" ? FileIcon : LinkIcon;
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <Icon className="size-4" />
    </span>
  );
}

/** Is this pin what the main area shows now? */
export function usePinActive(item: UnoPin): boolean {
  const location = useLocation({
    select: (l) => ({ pathname: l.pathname, search: l.search as Record<string, unknown> }),
  });
  return item.kind === "app"
    ? location.pathname === "/app" && location.search["url"] === item.target
    : item.kind === "folder"
      ? location.pathname === "/files" &&
        location.search["path"] === item.target &&
        !location.search["file"]
      : item.kind === "file"
        ? location.pathname === "/files" && location.search["file"] === item.target
        : false;
}

/** A click on a pin: an app inside Uno, a folder or file in Files, a link in a new tab. */
export function useOpenPin() {
  const navigate = useNavigate();
  const { openHere } = useOpenApp();
  const { isMobile, setOpenMobile } = useSidebar();
  return (item: UnoPin) => {
    if (isMobile) setOpenMobile(false);
    switch (item.kind) {
      case "app":
        openHere({ url: item.target, name: item.title, icon: item.icon ?? null });
        return;
      case "folder":
        void navigate({ to: "/files", search: { path: item.target } });
        return;
      case "file":
        void navigate({ to: "/files", search: { path: dirname(item.target), file: item.target } });
        return;
      case "link":
        openInNewTab(item.target);
    }
  };
}

function PinRow({
  item,
  onUnpin,
  onRename,
}: {
  item: UnoPin;
  onUnpin: () => void;
  onRename: () => void;
}) {
  const { openBeside } = useOpenApp();
  const active = usePinActive(item);
  const openPin = useOpenPin();
  const open = () => openPin(item);

  const showMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const choice = await api.contextMenu.show(
      [
        ...(item.kind === "app"
          ? [
              { id: "beside" as const, label: "Open beside a chat" },
              { id: "tab" as const, label: "Open in a new tab" },
            ]
          : []),
        { id: "rename" as const, label: "Rename" },
        { id: "unpin" as const, label: "Unpin", destructive: true },
      ],
      position,
    );
    if (choice === "beside") {
      openBeside({ url: item.target, name: item.title, icon: item.icon ?? null });
    } else if (choice === "tab") {
      openInNewTab(item.target);
    } else if (choice === "rename") {
      onRename();
    } else if (choice === "unpin") {
      onUnpin();
    }
  };

  return (
    <li className="group/pin relative list-none">
      <button
        type="button"
        onClick={open}
        onContextMenu={(event) => {
          event.preventDefault();
          void showMenu({ x: event.clientX, y: event.clientY });
        }}
        title={item.target}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg pr-7 pl-2 text-left text-sm outline-hidden ring-ring transition-colors focus-visible:ring-2",
          active
            ? "bg-sidebar-row-active text-foreground"
            : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover hover:text-foreground",
        )}
      >
        <span className="text-muted-foreground">
          <PinIcon item={item} />
        </span>
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
        {item.kind === "link" ? (
          <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground/60 group-hover/pin:hidden" />
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`Unpin ${item.title}`}
        title="Unpin"
        onClick={onUnpin}
        className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/pin:opacity-100 max-md:opacity-100"
      >
        <XIcon className="size-3.5" />
      </button>
    </li>
  );
}

function PinLinkDialog({
  open,
  onOpenChange,
  onPin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPin: (url: string, title: string) => void;
}) {
  const [address, setAddress] = useState("");
  const [title, setTitle] = useState("");
  const url = normalizeLinkInput(address);
  const submit = () => {
    if (!url) return;
    onPin(url, title.trim() || linkTitle(url));
    setAddress("");
    setTitle("");
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Pin a link</DialogTitle>
          <DialogDescription>
            It stays in the sidebar on this computer and opens in a new tab.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <Input
            autoFocus
            aria-label="Address"
            placeholder="figma.com/file/…"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
          <Input
            aria-label="Name"
            placeholder={url ? linkTitle(url) : "Name (optional)"}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
          {address.trim() !== "" && !url ? (
            <p className="text-xs text-destructive">That doesn't look like a web address.</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!url} onClick={submit}>
            Pin
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RenamePinDialog({
  item,
  onClose,
  onRename,
}: {
  item: UnoPin | null;
  onClose: () => void;
  onRename: (title: string) => void;
}) {
  const [title, setTitle] = useState("");
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
        else setTitle(item?.title ?? "");
      }}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename pin</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoFocus
            aria-label="Name"
            defaultValue={item?.title ?? ""}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onRename(title || item?.title || "");
              }
            }}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onRename(title || item?.title || "")}>
            <PencilIcon />
            Rename
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
