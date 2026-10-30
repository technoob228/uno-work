/**
 * What can land on a chat: files from the computer, or other chats from the
 * sidebar (their transcript goes along as a file the agent opens when it needs
 * it, so a long chat costs nothing until then; works across computers).
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { ensureEnvironmentApi } from "../../environmentApi";

const CHAT_DRAG_MIME = "application/x-uno-chats";
const MAX_TITLE_IN_FILE_NAME = 60;

export function writeChatDrag(
  dataTransfer: DataTransfer,
  chats: ReadonlyArray<ScopedThreadRef>,
): void {
  dataTransfer.setData(CHAT_DRAG_MIME, JSON.stringify(chats));
  dataTransfer.effectAllowed = "copy";
}

/** Works during dragover too: browsers show the types, not the data, until the drop. */
export function carriesChats(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(CHAT_DRAG_MIME);
}

export function carriesFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes("Files");
}

export function acceptsChatDrop(dataTransfer: DataTransfer): boolean {
  return carriesChats(dataTransfer) || carriesFiles(dataTransfer);
}

function isChatRef(value: unknown): value is ScopedThreadRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.environmentId === "string" && typeof ref.threadId === "string";
}

export function readChatDrag(dataTransfer: DataTransfer): ScopedThreadRef[] {
  const raw = dataTransfer.getData(CHAT_DRAG_MIME);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isChatRef) : [];
  } catch {
    return [];
  }
}

export function chatTranscriptFileName(title: string): string {
  const cleaned = title
    // oxlint-disable-next-line no-control-regex -- file names can't hold control characters.
    .replace(/[\u0000-\u001f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_IN_FILE_NAME)
    .trim();
  return `Chat - ${cleaned || "untitled"}.md`;
}

/** The chat's transcript, read on its own computer. */
export async function chatTranscriptFile(ref: ScopedThreadRef): Promise<File> {
  const transcript = await ensureEnvironmentApi(
    ref.environmentId,
  ).orchestration.getThreadTranscript({ threadId: ref.threadId });
  return new File([transcript.markdown], chatTranscriptFileName(transcript.title), {
    type: "text/markdown",
  });
}

export interface ComposerDrop {
  readonly files: ReadonlyArray<File>;
  readonly chats: ReadonlyArray<ScopedThreadRef>;
}

interface ComposerDropState {
  /** By composer key: a draft's id or a chat's scoped key. */
  readonly pending: Readonly<Record<string, ComposerDrop>>;
  /** A drop on a chat in the sidebar: it waits for that chat's composer. */
  readonly offer: (composerKey: string, drop: ComposerDrop) => void;
  readonly take: (composerKey: string) => ComposerDrop | null;
}

export const useComposerDropStore = create<ComposerDropState>((set, get) => ({
  pending: {},
  offer: (composerKey, drop) => {
    const current = get().pending[composerKey];
    set((state) => ({
      pending: {
        ...state.pending,
        [composerKey]: {
          files: [...(current?.files ?? []), ...drop.files],
          chats: [...(current?.chats ?? []), ...drop.chats],
        },
      },
    }));
  },
  take: (composerKey) => {
    const drop = get().pending[composerKey] ?? null;
    if (drop) {
      set((state) => {
        const { [composerKey]: _taken, ...rest } = state.pending;
        return { pending: rest };
      });
    }
    return drop;
  },
}));
