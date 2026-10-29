/**
 * "in [Home folder ▾]" on a new chat — where it works. A searchable list
 * (upstream T3 Code's draft project picker, #17664 / #10790: favicon, search
 * field, "Add project" last) over this computer's folders: the home folder,
 * every folder already worked in (newest chat first), then the ways to bring
 * one in — Another folder…, New folder…, Upload a folder…, Clone from
 * GitHub… (the folder chip's choices, so both say the same).
 *
 * `variant`: "inline" — a word in the draft screen's question; "chip" —
 * Home's composer row.
 */
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { ChevronDownIcon, FolderIcon, FolderOpenIcon, HouseIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { folderDisplayName, useHomeFolderPath } from "../../hooks/useFolderChats";
import { type ChatFolderSource, openFolderForChat } from "../../navigation/newProjectStore";
import { ChatInFolderDialog } from "../computer/ChatInFolderDialog";
import { BRING_FOLDER, type PickedFolder, useRecentFolders } from "../computer/FolderChipMenu";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button, InlineButton } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { DraftProjectName } from "./DraftProjectName";

const HOME_VALUE = "home";
const ANOTHER_VALUE = "action:another";
const sourceValue = (source: ChatFolderSource) => `action:${source}`;

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

export function NewChatFolderPicker({
  environmentId,
  folder,
  onPick,
  variant,
  testId = "new-chat-folder-picker",
}: {
  environmentId: EnvironmentId | null;
  /** The current folder; null = the home folder. */
  folder: PickedFolder | null;
  /**
   * null = the home folder. `projectRef` comes with a folder the picker has
   * just made (its project may not be in the store yet).
   */
  onPick: (folder: PickedFolder | null, projectRef?: ScopedProjectRef) => void | Promise<void>;
  variant: "inline" | "chip";
  testId?: string;
}) {
  const home = useHomeFolderPath(environmentId);
  const folders = useRecentFolders(environmentId, home);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pickingFolder, setPickingFolder] = useState(false);
  const filter = useComboboxFilter();

  const folderByValue = useMemo(
    () =>
      new Map<string, (typeof folders)[number]>(
        folders.map((project) => [`project:${project.id}`, project] as const),
      ),
    [folders],
  );
  const items = useMemo<PickerItem[]>(
    () => [
      { value: HOME_VALUE, label: "Home folder" },
      ...folders.map((project) => ({ value: `project:${project.id}`, label: project.name })),
      { value: ANOTHER_VALUE, label: "Another folder…" },
      ...BRING_FOLDER.map(({ source, label }) => ({ value: sourceValue(source), label })),
    ],
    [folders],
  );
  const search = query.trim();
  // While searching: folders only (the ways to bring one in stay for an empty field).
  const filteredItems =
    search.length === 0
      ? items
      : items.filter(
          (item) =>
            !item.value.startsWith("action:") &&
            filter.contains(item, search, (candidate) => candidate.label),
        );
  const selected =
    folder === null
      ? (items[0] ?? null)
      : (items.find((item) => folderByValue.get(item.value)?.cwd === folder.cwd) ?? null);
  const label = folder ? folder.name : "Home folder";

  const pick = (item: PickerItem) => {
    if (item.value === HOME_VALUE) return onPick(null);
    if (item.value === ANOTHER_VALUE) {
      setPickingFolder(true);
      return;
    }
    const bring = BRING_FOLDER.find(({ source }) => sourceValue(source) === item.value);
    if (bring) {
      openFolderForChat(bring.source, ({ name, folder: cwd, projectRef }) =>
        onPick({ cwd, name }, projectRef),
      );
      return;
    }
    const project = folderByValue.get(item.value);
    if (project) return onPick({ cwd: project.cwd, name: project.name });
  };

  return (
    <>
      <Combobox
        items={items}
        filteredItems={filteredItems}
        autoHighlight
        itemToStringLabel={(item: PickerItem) => item.label}
        isItemEqualToValue={(a: PickerItem, b: PickerItem) => a.value === b.value}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setQuery("");
        }}
        value={selected}
        onValueChange={(item: PickerItem | null) => {
          if (!item) return;
          setOpen(false);
          if (item.value === selected?.value) return;
          void pick(item);
        }}
      >
        {variant === "inline" ? (
          <ComboboxTrigger
            render={<InlineButton tone="picker" />}
            className="pointer-events-auto min-w-0 max-w-full align-baseline"
            data-testid={testId}
            title={folder ? folder.cwd : (home ?? "Home folder")}
          >
            <DraftProjectName value={label} singleLine />
            <ChevronDownIcon className="size-4 shrink-0 self-center opacity-50" />
          </ComboboxTrigger>
        ) : (
          <ComboboxTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                className="min-w-0 shrink text-muted-foreground"
                data-testid={testId}
                title={folder ? folder.cwd : (home ?? "Home folder")}
              />
            }
          >
            {folder ? <FolderIcon /> : <HouseIcon />}
            <span className="min-w-0 max-w-48 truncate">{label}</span>
            <ChevronDownIcon className="opacity-60" />
          </ComboboxTrigger>
        )}
        <ComboboxPopup
          align={variant === "inline" ? "center" : "start"}
          className="w-72 overflow-hidden"
        >
          <ComboboxSearchInput
            aria-label="Search folders"
            placeholder="Search folders..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>No matching folders.</ComboboxEmpty>
          <ComboboxList className="p-1" scrollAreaClassName="max-h-72">
            {(item: PickerItem) => {
              const project = folderByValue.get(item.value);
              const bring = BRING_FOLDER.find(({ source }) => sourceValue(source) === item.value);
              const isAction = item.value.startsWith("action:");
              return (
                <ComboboxItem
                  key={item.value}
                  hideIndicator
                  value={item}
                  className={cn(
                    "h-8 min-h-8 py-0",
                    // The ways to bring a folder in sit under a hairline.
                    item.value === ANOTHER_VALUE && "mt-1 border-t border-border/60 pt-1",
                  )}
                  contentClassName="flex min-w-0 items-center gap-2"
                  data-testid={`new-chat-folder-${item.value.replace(/[:]/g, "-")}`}
                >
                  {item.value === HOME_VALUE ? (
                    <HouseIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : project ? (
                    <ProjectFavicon
                      environmentId={project.environmentId}
                      cwd={project.cwd}
                      className="size-4 shrink-0"
                    />
                  ) : bring ? (
                    <bring.Icon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm",
                      isAction && "text-muted-foreground",
                    )}
                  >
                    {item.label}
                  </span>
                </ComboboxItem>
              );
            }}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      <ChatInFolderDialog
        environmentId={environmentId}
        open={pickingFolder}
        onOpenChange={setPickingFolder}
        title="Work in a folder"
        description="Uno works with the files in the folder you pick."
        actionLabel={(name) => `Work in ${name}`}
        actionIcon={<FolderIcon />}
        onStart={async (cwd) => {
          await onPick({ cwd, name: folderDisplayName(cwd) });
        }}
      />
    </>
  );
}
