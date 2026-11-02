/**
 * Settings → Keyboard, without React. One row per action: a custom rule for a
 * command replaces all its defaults on the daemon (mergeWithDefaultKeybindings),
 * so a change or a reset is per action too. Recording and the conflict test
 * follow upstream T3 Code's KeybindingsSettings.logic.ts; the `when` editor and
 * its source badges are left out on purpose.
 */
import type {
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  EVENT_CODE_SHORTCUT_KEYS,
  parseKeybindingShortcut,
} from "@t3tools/shared/keybindings";

import { formatShortcutLabel, shortcutConflictKey } from "../../keybindings";
import { isMacPlatform } from "../../lib/utils";

interface ActionCopy {
  readonly label: string;
  readonly group: KeyRowGroup;
  /** Shown only in Dev mode. */
  readonly dev?: boolean;
}

export type KeyRowGroup =
  | "Chats"
  | "Message box"
  | "Moving around"
  | "Terminal"
  | "Project scripts";

const GROUP_ORDER: ReadonlyArray<KeyRowGroup> = [
  "Chats",
  "Message box",
  "Moving around",
  "Terminal",
  "Project scripts",
];

const ACTION_COPY: Readonly<Partial<Record<KeybindingCommand, ActionCopy>>> = {
  "chat.new": { label: "New chat", group: "Chats" },
  "chat.newLocal": { label: "New chat in this project", group: "Chats" },
  "chat.find": { label: "Find in this chat", group: "Chats" },
  "thread.previous": { label: "Previous chat", group: "Chats" },
  "thread.next": { label: "Next chat", group: "Chats" },
  "thread.settle": { label: "Mark done", group: "Chats" },
  "thread.pin": { label: "Pin", group: "Chats" },
  "thread.undo": { label: "Undo Done, snooze or unpin", group: "Chats" },
  "composer.stash": { label: "Set the message aside", group: "Message box" },
  "composer.sendBackground": { label: "Send, stay on a new chat", group: "Message box" },
  "composer.sendAndNewThread": { label: "Send, start a new chat", group: "Message box" },
  "composer.host": { label: "Pick a computer", group: "Message box" },
  "composer.folder": { label: "Pick a folder", group: "Message box" },
  "modelPicker.toggle": { label: "Pick a model", group: "Message box" },
  "commandPalette.toggle": { label: "Search everything", group: "Moving around" },
  "sidebar.toggle": { label: "Show or hide the sidebar", group: "Moving around" },
  "rightPanel.toggle": { label: "Show or hide the panel", group: "Moving around" },
  "navigation.back": { label: "Back", group: "Moving around" },
  "navigation.forward": { label: "Forward", group: "Moving around" },
  "diff.toggle": { label: "Show changes", group: "Moving around", dev: true },
  "editor.openFavorite": { label: "Open in your editor", group: "Moving around", dev: true },
  "terminal.toggle": { label: "Show or hide the terminal", group: "Terminal", dev: true },
  "terminal.new": { label: "New terminal", group: "Terminal", dev: true },
  "terminal.split": { label: "Split the terminal", group: "Terminal", dev: true },
  "terminal.close": { label: "Close the terminal", group: "Terminal", dev: true },
};

/** Numbered commands read as one fixed line: nobody rebinds them one by one. */
const NUMBERED_COMMAND = /^(?:thread|modelPicker)\.jump\.\d$/;

export interface KeyRow {
  readonly command: KeybindingCommand;
  readonly label: string;
  readonly group: KeyRowGroup;
  /** Key rules as text (`mod+shift+s`), in the file's spelling; usually one. */
  readonly keys: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<string>;
  /** The first rule's condition: a new key works in the same place as the old one. */
  readonly when: string | undefined;
  readonly changed: boolean;
}

export interface KeyRowSection {
  readonly title: KeyRowGroup;
  readonly rows: ReadonlyArray<KeyRow>;
}

export function shortcutToKeybindingInput(shortcut: KeybindingShortcut): string {
  const parts: string[] = [];
  if (shortcut.modKey) parts.push("mod");
  if (shortcut.metaKey) parts.push("meta");
  if (shortcut.ctrlKey) parts.push("ctrl");
  if (shortcut.altKey) parts.push("alt");
  if (shortcut.shiftKey) parts.push("shift");
  parts.push(shortcut.key === " " ? "space" : shortcut.key === "escape" ? "esc" : shortcut.key);
  return parts.join("+");
}

type WhenNode = ResolvedKeybindingRule["whenAst"];

function whenToExpression(node: WhenNode): string | undefined {
  if (!node) return undefined;
  const wrapped = (inner: NonNullable<WhenNode>) =>
    inner.type === "identifier" || inner.type === "not"
      ? whenToExpression(inner)
      : `(${whenToExpression(inner)})`;
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrapped(node.node)}`;
    case "and":
      return `${wrapped(node.left)} && ${wrapped(node.right)}`;
    case "or":
      return `${wrapped(node.left)} || ${wrapped(node.right)}`;
  }
}

function copyFor(command: KeybindingCommand): ActionCopy | null {
  const known = ACTION_COPY[command];
  if (known) return known;
  const script = /^script\.(.+)\.run$/.exec(command);
  if (!script) return null;
  return { label: `Run ${script[1]!.replaceAll("-", " ")}`, group: "Project scripts", dev: true };
}

const defaultKeysFor = (command: KeybindingCommand): ReadonlyArray<string> =>
  DEFAULT_RESOLVED_KEYBINDINGS.filter((binding) => binding.command === command).map((binding) =>
    shortcutToKeybindingInput(binding.shortcut),
  );

export function buildKeyRows(
  keybindings: ResolvedKeybindingsConfig,
  options: { readonly devMode: boolean; readonly platform?: string },
): ReadonlyArray<KeyRow> {
  const platform = options.platform ?? navigator.platform;
  const byCommand = new Map<KeybindingCommand, ResolvedKeybindingRule[]>();
  for (const binding of keybindings) {
    if (NUMBERED_COMMAND.test(binding.command)) continue;
    const rules = byCommand.get(binding.command);
    if (rules) rules.push(binding);
    else byCommand.set(binding.command, [binding]);
  }
  const rows: KeyRow[] = [];
  for (const [command, rules] of byCommand) {
    const copy = copyFor(command);
    if (!copy || (copy.dev && !options.devMode)) continue;
    const keys = rules.map((rule) => shortcutToKeybindingInput(rule.shortcut));
    const defaults = defaultKeysFor(command);
    rows.push({
      command,
      label: copy.label,
      group: copy.group,
      keys,
      labels: rules.map((rule) => formatShortcutLabel(rule.shortcut, platform)),
      when: whenToExpression(rules[0]?.whenAst),
      changed: defaults.length > 0 && keys.join("\n") !== defaults.join("\n"),
    });
  }
  return rows;
}

export function groupKeyRows(rows: ReadonlyArray<KeyRow>): ReadonlyArray<KeyRowSection> {
  return GROUP_ORDER.flatMap((title) => {
    const groupRows = rows.filter((row) => row.group === title);
    return groupRows.length > 0 ? [{ title, rows: groupRows }] : [];
  });
}

export function filterKeyRows(rows: ReadonlyArray<KeyRow>, query: string): ReadonlyArray<KeyRow> {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) =>
      row.label.toLowerCase().includes(needle) ||
      row.keys.some((key) => key.includes(needle)) ||
      row.labels.some((label) => label.toLowerCase().includes(needle)),
  );
}

/** Two conditions that can both hold. A rule without one holds everywhere. */
function canOverlap(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

/** Which other actions these keys would also press. */
export function keyConflicts(
  rows: ReadonlyArray<KeyRow>,
  input: { readonly command: KeybindingCommand; readonly key: string; readonly when?: string },
  platform: string = navigator.platform,
): ReadonlyArray<string> {
  const shortcut = parseKeybindingShortcut(input.key);
  if (!shortcut) return [];
  const target = shortcutConflictKey(shortcut, platform);
  return rows
    .filter(
      (row) =>
        row.command !== input.command &&
        canOverlap(row.when, input.when) &&
        row.keys.some((key) => {
          const other = parseKeybindingShortcut(key);
          return other !== null && shortcutConflictKey(other, platform) === target;
        }),
    )
    .map((row) => row.label);
}

/** Keys a browser tab never gets, whatever the page does: the browser keeps them. */
const BROWSER_KEYS = new Set(["n", "t", "w"]);

export function browserKeepsShortcut(key: string): boolean {
  const shortcut = parseKeybindingShortcut(key);
  return (
    shortcut !== null &&
    (shortcut.modKey || shortcut.metaKey) &&
    !shortcut.altKey &&
    BROWSER_KEYS.has(shortcut.key)
  );
}

function recordedKey(event: Pick<KeyboardEvent, "key" | "code">): string | null {
  const key = (EVENT_CODE_SHORTCUT_KEYS[event.code] ?? event.key).toLowerCase();
  // ⌘ with Russian or another layout: the letter of the physical key.
  const letter = /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase();
  const token = letter ?? key;
  if (["meta", "control", "ctrl", "shift", "alt", "option", "os"].includes(token)) return null;
  if (token === " ") return "space";
  if (token === "escape") return "esc";
  if (token.length === 1 || /^f\d{1,2}$/.test(token)) return token;
  return /^(?:enter|tab|backspace|delete|home|end|pageup|pagedown|arrow(?:up|down|left|right))$/.test(
    token,
  )
    ? token
    : null;
}

/**
 * What a press of keys reads as in keybindings.json; null until it is a whole
 * shortcut. A bare letter is not one: it would stop being typable.
 */
export function keybindingFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: string = navigator.platform,
): string | null {
  const key = recordedKey(event);
  if (!key) return null;
  const parts: string[] = [];
  if (isMacPlatform(platform)) {
    if (event.metaKey) parts.push("mod");
    if (event.ctrlKey) parts.push("ctrl");
  } else {
    if (event.ctrlKey) parts.push("mod");
    if (event.metaKey) parts.push("meta");
  }
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  const modified = parts.some((part) => part !== "shift");
  if (!modified && !/^f\d{1,2}$/.test(key)) return null;
  parts.push(key);
  return parts.join("+");
}
