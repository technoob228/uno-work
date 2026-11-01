/** What the import screens say. No state and no React, so it can be read at a glance. */
import type {
  ImportedChatTool,
  MyComputerChatHistory,
  MyComputerImportStatus,
  MyComputerImportTool,
} from "@t3tools/contracts";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export const chatsLabel = (count: number) => plural(count, "chat");

const joinNames = (names: ReadonlyArray<string>) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** Programs the offer shows: something new to import, or a reason it can't. */
export const offeredTools = (tools: ReadonlyArray<MyComputerImportTool>) =>
  tools.filter((tool) => tool.newChats > 0 || !tool.available);

export function selectedTools(
  tools: ReadonlyArray<MyComputerImportTool>,
  unticked: ReadonlySet<ImportedChatTool>,
): ReadonlyArray<ImportedChatTool> {
  return offeredTools(tools)
    .filter((tool) => tool.available && !unticked.has(tool.id))
    .map((tool) => tool.id);
}

export function selectedChats(
  tools: ReadonlyArray<MyComputerImportTool>,
  unticked: ReadonlySet<ImportedChatTool>,
): number {
  const selected = new Set(selectedTools(tools, unticked));
  return tools.reduce((sum, tool) => (selected.has(tool.id) ? sum + tool.newChats : sum), 0);
}

export const hasOffer = (status: MyComputerImportStatus | undefined) =>
  status?.state === "ready" && status.tools.some((tool) => tool.available && tool.newChats > 0);

/**
 * "Included", not "all of them": Orca can keep Codex and OpenCode chats of its
 * managed accounts outside the default folders (see the M3 plan).
 */
export function alsoFoundLine(names: ReadonlyArray<string>): string | null {
  if (names.length === 0) return null;
  const [verb, owner] = names.length === 1 ? ["runs", "its"] : ["run", "their"];
  return `${joinNames(names)} ${verb} these tools, so chats in ${owner} default folders are included.`;
}

export function skippedLine(skipped: MyComputerImportStatus["skipped"]): string | null {
  const count = skipped.unreadable + skipped.unknownFormat;
  if (count === 0) return null;
  return `${plural(count, "file")} couldn't be read and ${count === 1 ? "was" : "were"} skipped.`;
}

export function importResultLine(result: NonNullable<MyComputerImportStatus["result"]>): string {
  const parts = [];
  if (result.recent > 0) {
    parts.push(`${result.recent} from today ${result.recent === 1 ? "is" : "are"} in the list`);
  }
  if (result.snoozed > 0) {
    parts.push(`${result.snoozed} older ${result.snoozed === 1 ? "one" : "ones"} in Snoozed`);
  }
  if (result.failed > 0) parts.push(`${result.failed} couldn't be added`);
  return parts.length > 0 ? `${parts.join(", ")}.` : "Nothing new to import.";
}

export function importedLine(status: MyComputerImportStatus | undefined): string | null {
  if (status === undefined || status.importedChats === 0) return null;
  return `${chatsLabel(status.importedChats)} · ${plural(status.importedProjects, "project")}`;
}

export interface ImportedChatNotice {
  readonly text: string;
  readonly retry: boolean;
}

/** What to say under an imported chat, beyond the fact that it is one. */
export function historyNotice(input: {
  readonly history: MyComputerChatHistory | undefined;
  readonly loading: boolean;
  readonly computerName: string;
}): ImportedChatNotice | null {
  const { history, loading, computerName } = input;
  if (history === undefined) {
    return loading
      ? { text: `Loading this chat from ${computerName}...`, retry: false }
      : { text: "Couldn't load this chat.", retry: true };
  }
  switch (history.kind) {
    case "offline":
      return {
        text: `${history.computerName} is offline. Open it or connect it again to read this chat.`,
        retry: true,
      };
    case "gone":
      return { text: `This chat is no longer on ${computerName}.`, retry: false };
    case "failed":
      return { text: history.message, retry: true };
    case "ready":
      if (history.stale) return { text: `Saved copy: ${computerName} is offline.`, retry: true };
      if (history.truncated) return { text: "Only the latest messages are shown.", retry: false };
      return null;
  }
}
