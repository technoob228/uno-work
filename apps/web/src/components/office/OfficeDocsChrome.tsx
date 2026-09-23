/**
 * The Docs shell's chrome: a Google-Docs-like title bar and one calm toolbar
 * for Word documents. The engine's ribbon is hidden inside its iframe (see
 * officeDocsShell.ts); every button here drives the engine through the shell.
 */
import {
  AlignCenterIcon,
  AlignJustifyIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ArrowLeftIcon,
  BaselineIcon,
  BoldIcon,
  ChevronDownIcon,
  CloudAlertIcon,
  CheckIcon,
  EllipsisVerticalIcon,
  FileDownIcon,
  FileTextIcon,
  FolderOpenIcon,
  HighlighterIcon,
  ImageIcon,
  ImagePlusIcon,
  IndentDecreaseIcon,
  IndentIncreaseIcon,
  ItalicIcon,
  Link2Icon,
  ListIcon,
  ListOrderedIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  MinusIcon,
  PanelTopIcon,
  PencilIcon,
  PlusIcon,
  PrinterIcon,
  Redo2Icon,
  RemoveFormattingIcon,
  ReplaceIcon,
  SaveIcon,
  SearchIcon,
  SeparatorHorizontalIcon,
  Share2Icon,
  StrikethroughIcon,
  TableIcon,
  UnderlineIcon,
  Undo2Icon,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarTrigger } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import {
  DOCS_COLORS,
  DOCS_FONT_SIZES,
  DOCS_STYLES,
  INITIAL_DOCS_STATE,
  type DocsAlign,
  type DocsCommand,
  type DocsFormatState,
  type DocsShell,
  commandReturnsFocus,
  splitDocName,
  stepFontSize,
  styleLabel,
} from "./officeDocsShell";
import { OFFICE_ENGINE_BASE } from "./officeEngine";

export type DocsSaveStatus =
  | { kind: "idle" }
  | { kind: "edited" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "error"; message: string };

const MOD =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘" : "Ctrl+";

function useShellState(shell: DocsShell | null): DocsFormatState {
  const subscribe = useCallback(
    (listener: () => void) => (shell ? shell.subscribe(listener) : () => undefined),
    [shell],
  );
  return useSyncExternalStore(
    subscribe,
    () => shell?.getState() ?? INITIAL_DOCS_STATE,
    () => INITIAL_DOCS_STATE,
  );
}

/* ---------------------------------------------------------------- pieces */

/** Keeps the keyboard in the document: pressing a toolbar button mustn't blur it. */
const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault();

function ToolButton({
  label,
  shortcut,
  active,
  className,
  children,
  ...props
}: ComponentProps<"button"> & { label: string; shortcut?: string; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={active}
            data-active={active ? "" : undefined}
            onMouseDown={keepFocus}
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/80 outline-none transition-colors",
              "hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:pointer-events-none disabled:opacity-35",
              "data-active:bg-primary/12 data-active:text-primary",
              "[&_svg]:size-4 [&_svg]:shrink-0",
              className,
            )}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label}
        {shortcut ? <span className="ms-1.5 text-muted-foreground">{shortcut}</span> : null}
      </TooltipPopup>
    </Tooltip>
  );
}

function Divider({ className }: { className?: string }) {
  return <span aria-hidden className={cn("mx-1 h-5 w-px shrink-0 bg-foreground/10", className)} />;
}

/** A text dropdown in the toolbar ("Normal text ▾", "Arial ▾"). */
function DropTrigger({
  label,
  children,
  className,
  ...props
}: ComponentProps<"button"> & { label: string }) {
  return (
    <MenuTrigger
      render={
        <button
          type="button"
          aria-label={label}
          onMouseDown={keepFocus}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[13px] text-foreground/85 outline-none transition-colors",
            "hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35",
            className,
          )}
          {...props}
        />
      }
    >
      <span className="min-w-0 flex-1 truncate text-start">{children}</span>
      <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
    </MenuTrigger>
  );
}

function ColorPicker({
  label,
  icon,
  value,
  automaticLabel,
  onPick,
  className,
}: {
  className?: string;
  label: string;
  icon: ReactNode;
  value: string | null;
  automaticLabel: string;
  onPick: (hex: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label={label}
              onMouseDown={keepFocus}
              className={cn(
                "relative inline-flex size-7 shrink-0 flex-col items-center justify-center rounded-md text-foreground/80 outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
                className,
              )}
            />
          }
        >
          {icon}
          <span
            aria-hidden
            className="absolute bottom-1 left-1.5 right-1.5 h-[3px] rounded-full"
            style={{ background: value ? `#${value}` : "currentColor", opacity: value ? 1 : 0.7 }}
          />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="start" className="w-[212px] [--viewport-inline-padding:--spacing(3)]">
        <div className="-my-1 space-y-2">
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => {
              onPick(null);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent"
          >
            <span className="size-4 rounded-full border border-foreground/20 bg-[linear-gradient(135deg,transparent_45%,var(--color-red-500)_45%,var(--color-red-500)_55%,transparent_55%)]" />
            {automaticLabel}
          </button>
          <div className="grid grid-cols-8 gap-1.5">
            {DOCS_COLORS.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={`#${hex}`}
                onMouseDown={keepFocus}
                onClick={() => {
                  onPick(hex);
                  setOpen(false);
                }}
                className={cn(
                  "size-5 rounded-full ring-offset-2 ring-offset-popover transition-transform hover:scale-110",
                  value === hex ? "ring-2 ring-primary" : "ring-1 ring-foreground/10",
                )}
                style={{ background: `#${hex}` }}
              />
            ))}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

const ALIGN_ICON: Record<DocsAlign, typeof AlignLeftIcon> = {
  left: AlignLeftIcon,
  center: AlignCenterIcon,
  right: AlignRightIcon,
  justify: AlignJustifyIcon,
};
const ALIGN_LABEL: Record<DocsAlign, string> = {
  left: "Left align",
  center: "Center align",
  right: "Right align",
  justify: "Justify",
};

/* ---------------------------------------------------------------- title bar */

function SaveStatusLabel({ status }: { status: DocsSaveStatus }) {
  const base = "inline-flex items-center gap-1 text-xs text-muted-foreground";
  switch (status.kind) {
    case "saving":
      return (
        <span className={base} data-testid="office-save-state">
          <Loader2Icon className="size-3 animate-spin" />
          Saving…
        </span>
      );
    case "saved":
      return (
        <span className={base} data-testid="office-save-state" title={status.at.toLocaleString()}>
          <CheckIcon className="size-3" />
          Saved
        </span>
      );
    case "edited":
      return (
        <span className={base} data-testid="office-save-state">
          Edited
        </span>
      );
    case "error":
      return (
        <span
          className={cn(base, "text-destructive-foreground")}
          data-testid="office-save-state"
          title={status.message}
        >
          <CloudAlertIcon className="size-3" />
          Not saved
        </span>
      );
    default:
      return <span className={base} data-testid="office-save-state" />;
  }
}

function DocName({
  fileName,
  onRename,
}: {
  fileName: string;
  onRename?: ((newName: string) => Promise<void>) | undefined;
}) {
  const { base, extension } = splitDocName(fileName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(base);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) setDraft(base);
  }, [base, editing]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = async () => {
    const next = draft.trim();
    if (!onRename || next.length === 0 || next === base) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onRename(`${next}${extension}`);
      setEditing(false);
    } catch {
      // The caller already said why; let the person fix the name.
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        disabled={busy}
        aria-label="Document name"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commit();
          if (event.key === "Escape") {
            setDraft(base);
            setEditing(false);
          }
        }}
        style={{ width: `${Math.max(8, Math.min(48, draft.length + 2))}ch` }}
        className="h-7 min-w-0 rounded-md border border-primary/50 bg-background px-1.5 text-[15px] text-foreground outline-none ring-2 ring-primary/15"
      />
    );
  }
  return (
    <button
      type="button"
      disabled={!onRename}
      onClick={() => setEditing(true)}
      title={onRename ? "Rename" : fileName}
      data-testid="office-doc-name"
      className="h-7 min-w-0 truncate rounded-md border border-transparent px-1.5 text-start text-[15px] text-foreground transition-colors enabled:hover:border-foreground/15 disabled:cursor-default"
    >
      {base}
      <span className="text-muted-foreground">{extension}</span>
    </button>
  );
}

/* ---------------------------------------------------------------- chrome */

export interface OfficeDocsChromeProps {
  fileName: string;
  shell: DocsShell | null;
  status: DocsSaveStatus;
  canSave: boolean;
  onBack: () => void;
  onSave: () => void;
  onDownload: (format: "docx" | "pdf" | "odt") => void;
  onShare?: (() => void) | undefined;
  onShowInFiles: () => void;
  onRename?: ((newName: string) => Promise<void>) | undefined;
}

export function OfficeDocsChrome(props: OfficeDocsChromeProps) {
  const { fileName, shell, status } = props;
  const state = useShellState(shell);
  const disabled = !shell;

  const run = useCallback(
    (command: DocsCommand) => {
      if (!shell) return;
      shell.run(command);
      // Menus hand focus back to their trigger when they close; give it back
      // to the document right after (dialogs keep theirs).
      if (commandReturnsFocus(command)) window.setTimeout(() => shell.focus(), 0);
    },
    [shell],
  );
  const fonts = shell ? shell.fonts() : [];

  return (
    <TooltipProvider delay={400} closeDelay={0} timeout={300}>
      <header className="shrink-0 bg-background" data-testid="office-docs-chrome">
        {/* Title bar */}
        <div className="flex h-12 items-center gap-1.5 px-3">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <Button size="icon-xs" variant="ghost" aria-label="Back to Files" onClick={props.onBack}>
            <ArrowLeftIcon />
          </Button>
          <FileTextIcon className="ms-0.5 size-5 shrink-0 text-blue-600" aria-hidden />
          <div className="flex min-w-0 items-center gap-2">
            <DocName fileName={fileName} onRename={props.onRename} />
            <SaveStatusLabel status={status} />
          </div>
          <div className="ms-auto flex shrink-0 items-center gap-1.5">
            {/* AGPL 7(b): the engine's logo stays visible even with its ribbon hidden. */}
            <img
              src={`${OFFICE_ENGINE_BASE}vendor/web-apps/apps/common/main/resources/img/header/dark-logo_s.svg`}
              alt="ONLYOFFICE"
              title="Editor by ONLYOFFICE (AGPL-3.0)"
              className="me-1 h-4 w-auto opacity-45 max-sm:hidden dark:invert"
              draggable={false}
            />
            <Menu>
              <MenuTrigger
                render={<Button size="sm" variant="ghost" data-testid="office-file-menu" />}
              >
                File
                <ChevronDownIcon className="opacity-60" />
              </MenuTrigger>
              <MenuPopup align="end" className="w-60">
                <MenuItem onClick={props.onSave} disabled={!props.canSave}>
                  <SaveIcon />
                  Save now
                  <MenuShortcut>{MOD}S</MenuShortcut>
                </MenuItem>
                {props.onRename ? (
                  <MenuItem
                    onClick={() =>
                      document
                        .querySelector<HTMLButtonElement>('[data-testid="office-doc-name"]')
                        ?.click()
                    }
                  >
                    <PencilIcon />
                    Rename
                  </MenuItem>
                ) : null}
                <MenuItem onClick={props.onShowInFiles}>
                  <FolderOpenIcon />
                  Show in Files
                </MenuItem>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>Download</MenuGroupLabel>
                  <MenuItem onClick={() => props.onDownload("docx")} disabled={disabled}>
                    <FileDownIcon />
                    Word document (.docx)
                  </MenuItem>
                  <MenuItem onClick={() => props.onDownload("pdf")} disabled={disabled}>
                    <FileDownIcon />
                    PDF document (.pdf)
                  </MenuItem>
                  <MenuItem onClick={() => props.onDownload("odt")} disabled={disabled}>
                    <FileDownIcon />
                    OpenDocument (.odt)
                  </MenuItem>
                </MenuGroup>
                <MenuSeparator />
                <MenuItem onClick={() => run({ type: "print" })} disabled={disabled}>
                  <PrinterIcon />
                  Print
                  <MenuShortcut>{MOD}P</MenuShortcut>
                </MenuItem>
              </MenuPopup>
            </Menu>
            {props.onShare ? (
              <Button size="sm" onClick={props.onShare} data-testid="office-share">
                <Share2Icon />
                Share
              </Button>
            ) : null}
          </div>
        </div>

        {/* Toolbar */}
        <div className="@container/docs-toolbar px-3 pb-2">
          <div
            role="toolbar"
            aria-label="Formatting"
            data-testid="office-docs-toolbar"
            className="flex h-10 items-center rounded-full bg-muted/70 px-2 dark:bg-muted/40"
          >
            {/* Scrolls sideways on narrow screens; Find and ⋯ stay put. */}
            <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
              <ToolButton
                label="Undo"
                shortcut={`${MOD}Z`}
                disabled={disabled || !state.canUndo}
                onClick={() => run({ type: "undo" })}
              >
                <Undo2Icon />
              </ToolButton>
              <ToolButton
                label="Redo"
                shortcut={`${MOD}Y`}
                disabled={disabled || !state.canRedo}
                onClick={() => run({ type: "redo" })}
              >
                <Redo2Icon />
              </ToolButton>
              <Divider className="@max-[980px]/docs-toolbar:hidden" />
              <Menu>
                <DropTrigger
                  label="Zoom"
                  disabled={disabled}
                  className="w-[68px] @max-[980px]/docs-toolbar:hidden"
                  data-testid="office-zoom"
                >
                  {state.zoom ? `${Math.round(state.zoom)}%` : "100%"}
                </DropTrigger>
                <MenuPopup align="start" className="w-36">
                  <MenuItem onClick={() => run({ type: "zoomFitWidth" })}>Fit width</MenuItem>
                  <MenuSeparator />
                  {[50, 75, 90, 100, 125, 150, 200].map((percent) => (
                    <MenuItem key={percent} onClick={() => run({ type: "zoom", percent })}>
                      {percent}%
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>

              <Divider className="@max-[980px]/docs-toolbar:hidden" />
              <Menu>
                <DropTrigger
                  label="Styles"
                  disabled={disabled}
                  className="w-[118px]"
                  data-testid="office-style"
                >
                  {styleLabel(state.style)}
                </DropTrigger>
                <MenuPopup align="start" className="w-64">
                  {DOCS_STYLES.map((style) => (
                    <MenuItem
                      key={style.name}
                      onClick={() => run({ type: "style", name: style.name })}
                      className="gap-3"
                    >
                      <CheckIcon
                        className={cn(
                          "size-3.5",
                          styleLabel(state.style) === style.label ? "opacity-80" : "opacity-0",
                        )}
                      />
                      <span className={STYLE_PREVIEW[style.name]}>{style.label}</span>
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>

              <Divider />
              <Menu>
                <DropTrigger
                  label="Font"
                  disabled={disabled}
                  className="w-[124px] @max-[860px]/docs-toolbar:hidden"
                  data-testid="office-font"
                >
                  {state.fontName ?? "Font"}
                </DropTrigger>
                <MenuPopup align="start" className="max-h-80 w-56">
                  {fonts.map((font) => (
                    <MenuItem
                      key={font}
                      onClick={() => run({ type: "fontName", name: font })}
                      className="gap-3"
                    >
                      <CheckIcon
                        className={cn(
                          "size-3.5",
                          state.fontName === font ? "opacity-80" : "opacity-0",
                        )}
                      />
                      <span style={{ fontFamily: `"${font}"` }}>{font}</span>
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>

              <Divider className="@max-[860px]/docs-toolbar:hidden" />
              <ToolButton
                label="Decrease font size"
                className="@max-[800px]/docs-toolbar:hidden"
                disabled={disabled}
                onClick={() => run({ type: "fontSize", size: stepFontSize(state.fontSize, -1) })}
              >
                <MinusIcon />
              </ToolButton>
              <Menu>
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Font size"
                      data-testid="office-font-size"
                      onMouseDown={keepFocus}
                      disabled={disabled}
                      className="inline-flex h-7 min-w-9 shrink-0 items-center justify-center rounded-md border border-foreground/15 bg-background px-1 text-[13px] tabular-nums text-foreground outline-none hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35"
                    />
                  }
                >
                  {state.fontSize ?? "–"}
                </MenuTrigger>
                <MenuPopup align="center" className="max-h-80 w-20">
                  {DOCS_FONT_SIZES.map((size) => (
                    <MenuItem
                      key={size}
                      onClick={() => run({ type: "fontSize", size })}
                      className="justify-center tabular-nums"
                    >
                      {size}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
              <ToolButton
                label="Increase font size"
                className="@max-[800px]/docs-toolbar:hidden"
                disabled={disabled}
                onClick={() => run({ type: "fontSize", size: stepFontSize(state.fontSize, 1) })}
              >
                <PlusIcon />
              </ToolButton>

              <Divider />
              <ToolButton
                label="Bold"
                shortcut={`${MOD}B`}
                active={state.bold}
                disabled={disabled}
                data-testid="office-bold"
                onClick={() => run({ type: "bold" })}
              >
                <BoldIcon />
              </ToolButton>
              <ToolButton
                label="Italic"
                shortcut={`${MOD}I`}
                active={state.italic}
                disabled={disabled}
                onClick={() => run({ type: "italic" })}
              >
                <ItalicIcon />
              </ToolButton>
              <ToolButton
                label="Underline"
                shortcut={`${MOD}U`}
                active={state.underline}
                disabled={disabled}
                onClick={() => run({ type: "underline" })}
              >
                <UnderlineIcon />
              </ToolButton>
              <ToolButton
                label="Strikethrough"
                active={state.strikeout}
                disabled={disabled}
                onClick={() => run({ type: "strikeout" })}
                className="@max-[1260px]/docs-toolbar:hidden"
              >
                <StrikethroughIcon />
              </ToolButton>
              <ColorPicker
                label="Text color"
                icon={<BaselineIcon />}
                value={state.color}
                automaticLabel="Automatic"
                onPick={(hex) => run({ type: "color", hex })}
              />
              <ColorPicker
                label="Highlight color"
                icon={<HighlighterIcon />}
                value={null}
                automaticLabel="None"
                onPick={(hex) => run({ type: "highlight", hex })}
                className="@max-[760px]/docs-toolbar:hidden"
              />

              <Divider />
              <ToolButton
                label="Insert link"
                shortcut={`${MOD}K`}
                disabled={disabled}
                onClick={() => run({ type: "link" })}
              >
                <Link2Icon />
              </ToolButton>
              <ToolButton
                label="Add comment"
                disabled={disabled}
                onClick={() => run({ type: "comment" })}
              >
                <MessageSquarePlusIcon />
              </ToolButton>
              <Menu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <MenuTrigger
                        aria-label="Insert image"
                        disabled={disabled}
                        onMouseDown={keepFocus}
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/80 outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35 [&_svg]:size-4"
                      />
                    }
                  >
                    <ImageIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">Insert image</TooltipPopup>
                </Tooltip>
                <MenuPopup align="start" className="w-52">
                  <MenuItem onClick={() => run({ type: "imageFromFile" })}>
                    <ImagePlusIcon />
                    Upload from computer
                  </MenuItem>
                  <MenuItem onClick={() => run({ type: "imageFromUrl" })}>
                    <Link2Icon />
                    By URL…
                  </MenuItem>
                </MenuPopup>
              </Menu>

              <Divider />
              {(["left", "center", "right", "justify"] as const).map((align) => {
                const Icon = ALIGN_ICON[align];
                return (
                  <ToolButton
                    key={align}
                    label={ALIGN_LABEL[align]}
                    active={state.align === align}
                    disabled={disabled}
                    onClick={() => run({ type: "align", align })}
                    className={
                      align === "justify"
                        ? "@max-[1160px]/docs-toolbar:hidden"
                        : align === "left"
                          ? undefined
                          : "@max-[640px]/docs-toolbar:hidden"
                    }
                  >
                    <Icon />
                  </ToolButton>
                );
              })}

              <Divider />
              <ToolButton
                label="Bulleted list"
                active={state.list === "bullet"}
                disabled={disabled}
                data-testid="office-bullets"
                onClick={() => run({ type: "list", list: "bullet" })}
              >
                <ListIcon />
              </ToolButton>
              <ToolButton
                label="Numbered list"
                active={state.list === "number"}
                disabled={disabled}
                onClick={() => run({ type: "list", list: "number" })}
              >
                <ListOrderedIcon />
              </ToolButton>
              <ToolButton
                label="Decrease indent"
                disabled={disabled}
                onClick={() => run({ type: "indent", direction: "out" })}
                className="@max-[1160px]/docs-toolbar:hidden"
              >
                <IndentDecreaseIcon />
              </ToolButton>
              <ToolButton
                label="Increase indent"
                disabled={disabled}
                onClick={() => run({ type: "indent", direction: "in" })}
                className="@max-[1160px]/docs-toolbar:hidden"
              >
                <IndentIncreaseIcon />
              </ToolButton>
              <ToolButton
                label="Clear formatting"
                disabled={disabled}
                onClick={() => run({ type: "clearFormatting" })}
                className="@max-[1060px]/docs-toolbar:hidden"
              >
                <RemoveFormattingIcon />
              </ToolButton>
            </div>
            <div className="flex shrink-0 items-center gap-0.5 border-s border-foreground/10 ps-1.5 ms-1">
              <ToolButton
                label="Find"
                shortcut={`${MOD}F`}
                disabled={disabled}
                onClick={() => run({ type: "find" })}
              >
                <SearchIcon />
              </ToolButton>
              <Menu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <MenuTrigger
                        aria-label="More"
                        disabled={disabled}
                        onMouseDown={keepFocus}
                        data-testid="office-more"
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/80 outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-35 [&_svg]:size-4"
                      />
                    }
                  >
                    <EllipsisVerticalIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">More</TooltipPopup>
                </Tooltip>
                <MenuPopup align="end" className="w-60">
                  <MenuItem onClick={() => run({ type: "table" })}>
                    <TableIcon />
                    Table…
                  </MenuItem>
                  <MenuItem onClick={() => run({ type: "pageBreak" })}>
                    <SeparatorHorizontalIcon />
                    Page break
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem onClick={() => run({ type: "strikeout" })}>
                    <StrikethroughIcon />
                    Strikethrough
                  </MenuItem>
                  <MenuItem onClick={() => run({ type: "indent", direction: "in" })}>
                    <IndentIncreaseIcon />
                    Increase indent
                  </MenuItem>
                  <MenuItem onClick={() => run({ type: "indent", direction: "out" })}>
                    <IndentDecreaseIcon />
                    Decrease indent
                  </MenuItem>
                  <MenuItem onClick={() => run({ type: "clearFormatting" })}>
                    <RemoveFormattingIcon />
                    Clear formatting
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem onClick={() => run({ type: "replace" })}>
                    <ReplaceIcon />
                    Find and replace
                    <MenuShortcut>{MOD}H</MenuShortcut>
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    onClick={() => run({ type: "fullToolbar", show: !state.fullToolbar })}
                    data-testid="office-full-toolbar"
                  >
                    <PanelTopIcon />
                    {state.fullToolbar ? "Hide full toolbar" : "Show full toolbar"}
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
          </div>
        </div>
      </header>
    </TooltipProvider>
  );
}

/** How each style looks in the style menu (a hint, not the document's own style). */
const STYLE_PREVIEW: Record<string, string> = {
  Normal: "text-sm",
  Title: "text-2xl leading-tight",
  Subtitle: "text-base text-muted-foreground",
  "Heading 1": "text-xl font-medium leading-tight",
  "Heading 2": "text-lg font-medium leading-tight",
  "Heading 3": "text-base font-medium text-foreground/80",
};
