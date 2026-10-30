/**
 * "in [Home folder ▾]" on a new chat — where it works. A searchable list
 * (upstream T3 Code's draft project picker, #17664 / #10790: favicon, search
 * field, "Add project" last) over this computer's folders: the home folder,
 * every folder already worked in (newest chat first), then the ways to bring
 * one in — Another folder…, New folder…, Upload a folder…, Clone from
 * GitHub… (the folder chip's choices, so both say the same). With the
 * assistants update the list also has the assistants, right under the home
 * folder (Misha 30.10): a chat can start with one instead of in a folder.
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
import { AssistantAvatar, avatarImageOf } from "../assistants/AssistantAvatar";
import type { TeamMember } from "../assistants/useAssistantTeam";
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
import { usePickerShortcut, withShortcutHint } from "./usePickerShortcut";

const NO_ASSISTANTS: ReadonlyArray<TeamMember> = [];
const HOME_VALUE = "home";
const ANOTHER_VALUE = "action:another";
const sourceValue = (source: ChatFolderSource) => `action:${source}`;
const assistantValue = (member: TeamMember) => `assistant:${member.key}`;

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
  shortcut = true,
  assistants = NO_ASSISTANTS,
  assistant = null,
  onPickAssistant,
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
  /** ⌘⇧F opens it (on by default; one picker per screen). */
  shortcut?: boolean;
  /** Offered next to the folders; empty - folders only. */
  assistants?: ReadonlyArray<TeamMember>;
  /** The chat starts with this assistant; it says so instead of the folder. */
  assistant?: TeamMember | null;
  onPickAssistant?: (member: TeamMember) => void | Promise<void>;
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
  const assistantByValue = useMemo(
    () => new Map(assistants.map((member) => [assistantValue(member), member] as const)),
    [assistants],
  );
  const items = useMemo<PickerItem[]>(
    () => [
      { value: HOME_VALUE, label: "Home folder" },
      ...assistants.map((member) => ({
        value: assistantValue(member),
        label: member.profile.name,
      })),
      ...folders.map((project) => ({ value: `project:${project.id}`, label: project.name })),
      { value: ANOTHER_VALUE, label: "Another folder…" },
      ...BRING_FOLDER.map(({ source, label }) => ({ value: sourceValue(source), label })),
    ],
    [assistants, folders],
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
  const selected = assistant
    ? (items.find((item) => item.value === assistantValue(assistant)) ?? null)
    : folder === null
      ? (items[0] ?? null)
      : (items.find((item) => folderByValue.get(item.value)?.cwd === folder.cwd) ?? null);
  const label = assistant ? assistant.profile.name : folder ? folder.name : "Home folder";
  // A hairline opens each group, while the whole list shows.
  const firstOfGroup = new Set(
    search.length > 0
      ? []
      : [
          assistants[0] ? assistantValue(assistants[0]) : null,
          assistants.length > 0 && folders[0] ? `project:${folders[0].id}` : null,
          ANOTHER_VALUE,
        ],
  );
  const searchNoun = assistants.length > 0 ? "folders and assistants" : "folders";
  const shortcutLabel = usePickerShortcut("composer.folder", shortcut, () => {
    setOpen((value) => !value);
    setQuery("");
  });
  const title = withShortcutHint(
    assistant ? assistant.profile.name : folder ? folder.cwd : (home ?? "Home folder"),
    shortcutLabel,
  );

  const pick = (item: PickerItem) => {
    if (item.value === HOME_VALUE) return onPick(null);
    const member = assistantByValue.get(item.value);
    if (member) return onPickAssistant?.(member);
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
            title={title}
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
                title={title}
              />
            }
          >
            {assistant ? (
              <AssistantAvatar
                emoji={assistant.profile.emoji}
                image={avatarImageOf(assistant.profile)}
                tone={assistant.profile.tone}
                className="size-4"
              />
            ) : folder ? (
              <FolderIcon />
            ) : (
              <HouseIcon />
            )}
            <span className="min-w-0 max-w-48 truncate">{label}</span>
            <ChevronDownIcon className="opacity-60" />
          </ComboboxTrigger>
        )}
        <ComboboxPopup
          align={variant === "inline" ? "center" : "start"}
          className="w-72 overflow-hidden"
        >
          <ComboboxSearchInput
            aria-label={`Search ${searchNoun}`}
            placeholder={assistants.length > 0 ? "Search..." : "Search folders..."}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>No matching {searchNoun}.</ComboboxEmpty>
          <ComboboxList className="p-1" scrollAreaClassName="max-h-72">
            {(item: PickerItem) => {
              const project = folderByValue.get(item.value);
              const member = assistantByValue.get(item.value);
              const bring = BRING_FOLDER.find(({ source }) => sourceValue(source) === item.value);
              const isAction = item.value.startsWith("action:");
              return (
                <ComboboxItem
                  key={item.value}
                  hideIndicator
                  value={item}
                  className={cn(
                    "h-8 min-h-8 py-0",
                    firstOfGroup.has(item.value) &&
                      "mt-1 h-9 min-h-9 border-t border-border/60 pt-1",
                  )}
                  contentClassName="flex min-w-0 items-center gap-2"
                  data-testid={`new-chat-folder-${item.value.replace(/[:]/g, "-")}`}
                >
                  {item.value === HOME_VALUE ? (
                    <HouseIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : member ? (
                    <AssistantAvatar
                      emoji={member.profile.emoji}
                      image={avatarImageOf(member.profile)}
                      tone={member.profile.tone}
                      className="size-4"
                    />
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
