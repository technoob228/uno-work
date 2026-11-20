/**
 * Demo T54 (Misha 20.11): how big New chat should be. Three variants of the
 * real sidebar, picked by the address (`?ncb=a|b|c`, kept in the browser):
 *
 * - A — as T53: the small icon in the "My chats" line, with the picker;
 * - B — a full-width "New chat ⌘N" button on top of the sidebar, same picker;
 * - C — a split button on top: "New chat in landing" starts at once where the
 *   picker would (the last folder and computer), ▾ opens the picker.
 *
 * Demo only (branch demo/new-chat-button-1120), not for prod as is.
 */
import { ChevronDownIcon, SquarePenIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { cn } from "../../lib/utils";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  NewChatPickerButton,
  useNewChatDefaultLabel,
  useStartNewChatAtDefault,
} from "./NewChatPicker";

export type NewChatButtonVariant = "a" | "b" | "c";

const STORAGE_KEY = "uno.demo.newChatButton";

export function readNewChatButtonVariant(): NewChatButtonVariant {
  if (typeof window === "undefined") return "a";
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("ncb");
    if (fromUrl === "a" || fromUrl === "b" || fromUrl === "c") {
      window.localStorage.setItem(STORAGE_KEY, fromUrl);
      return fromUrl;
    }
    const kept = window.localStorage.getItem(STORAGE_KEY);
    return kept === "b" || kept === "c" ? kept : "a";
  } catch {
    return "a";
  }
}

/** The small icon in "My chats" stays only in variant A. */
export function smallNewChatShown(): boolean {
  return readNewChatButtonVariant() === "a";
}

export function NewChatTopButton(props: {
  shortcutLabel: string | null;
  onShiftClick: (event: ReactMouseEvent) => void;
}) {
  const variant = readNewChatButtonVariant();
  if (variant === "b") return <VariantB {...props} />;
  if (variant === "c") return <VariantC {...props} />;
  return null;
}

function ShortcutHint({ label }: { label: string | null }) {
  return label ? (
    <Kbd className="ml-auto h-4.5 bg-transparent px-0 text-[11px] text-muted-foreground/80">
      {label}
    </Kbd>
  ) : null;
}

function VariantB(props: {
  shortcutLabel: string | null;
  onShiftClick: (event: ReactMouseEvent) => void;
}) {
  return (
    <div className="px-0.5 pt-2">
      <NewChatPickerButton
        tooltip="Pick the folder and the computer"
        testId="sidebar-top-new-chat"
        side="bottom"
        align="start"
        onShiftClick={props.onShiftClick}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-2.5 text-sm font-medium text-foreground shadow-xs outline-hidden transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-row-hover"
      >
        <SquarePenIcon className="size-4 shrink-0" />
        New chat
        <ShortcutHint label={props.shortcutLabel} />
      </NewChatPickerButton>
    </div>
  );
}

function VariantC(props: {
  shortcutLabel: string | null;
  onShiftClick: (event: ReactMouseEvent) => void;
}) {
  const start = useStartNewChatAtDefault();
  const where = useNewChatDefaultLabel();
  return (
    <div className="px-0.5 pt-2">
      <div className="flex h-8 w-full items-stretch overflow-hidden rounded-lg bg-primary text-primary-foreground shadow-xs">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-testid="sidebar-top-new-chat"
                onClick={() => void start()}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 text-left outline-hidden hover:bg-primary/88 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              />
            }
          >
            <SquarePenIcon className="size-4 shrink-0" />
            <span className="shrink-0 text-sm font-semibold">New chat</span>
            {where ? (
              <span className="min-w-0 truncate text-xs text-primary-foreground/75">
                in {where.folder}
              </span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {where ? `New chat in ${where.folder} on ${where.computer}` : "New chat"}
            {props.shortcutLabel ? ` · ${props.shortcutLabel}` : ""}
          </TooltipPopup>
        </Tooltip>
        <NewChatPickerButton
          label="Pick the folder and the computer"
          tooltip="Another folder or computer"
          testId="sidebar-top-new-chat-picker"
          side="bottom"
          align="end"
          onShiftClick={props.onShiftClick}
          className={cn(
            "flex w-7 shrink-0 cursor-pointer items-center justify-center border-l border-primary-foreground/25 outline-hidden hover:bg-primary/88 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-primary/80",
          )}
        >
          <ChevronDownIcon className="size-4" />
        </NewChatPickerButton>
      </div>
    </div>
  );
}
