/**
 * Everything the prototype knows and can change, in one zustand store.
 *
 * Three independent questions are being compared (A new chat / project,
 * B assistant model, C Inbox), each with its own variant; the shell reads all
 * three, so any combination can be clicked through. `focus` is the section
 * the dock touched last — the notes panel explains that section's variant.
 *
 * Highlight rule (the 0.0.80 double-highlight fix, same in every variant):
 * the sidebar highlights exactly the row whose screen is open. Home and Inbox
 * are screens (or a popover), never sidebar modes, so opening them never
 * hides the chat list.
 */
import { create } from "zustand";

import {
  ASSISTANT_ID,
  HOME_PROJECT_ID,
  INBOX,
  PROJECTS,
  THREADS,
  type InboxItem,
  type Project,
  type Thread,
} from "./data";

export type NewVariant = "a1" | "a2" | "a3";
export type AssistantVariant = "b1" | "b2" | "b3";
export type InboxVariant = "c1" | "c2" | "c3";
export type Section = "a" | "b" | "c";

export type Screen =
  | { readonly kind: "home" }
  | { readonly kind: "chat"; readonly threadId: string }
  | { readonly kind: "inbox" }
  | { readonly kind: "app"; readonly appId: string }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "new-project" }
  | { readonly kind: "settings-telegram" };

export interface Toast {
  readonly id: number;
  readonly title: string;
  readonly description?: string;
}

interface ProtoState {
  readonly screen: Screen;
  readonly focus: Section;
  readonly newVariant: NewVariant;
  readonly assistantVariant: AssistantVariant;
  readonly inboxVariant: InboxVariant;
  readonly notesOpen: boolean;

  readonly projects: ReadonlyArray<Project>;
  readonly threads: ReadonlyArray<Thread>;
  readonly inbox: ReadonlyArray<InboxItem>;
  readonly toasts: ReadonlyArray<Toast>;

  /** A1: the "New project" dialog. */
  readonly newProjectOpen: boolean;
  /** B1/B2: the assistant settings sheet for this chat id. */
  readonly assistantSheet: string | null;
  /** B3: Telegram is linked to the person (not to a chat). */
  readonly telegramLinked: boolean;

  go(screen: Screen): void;
  setVariant(section: Section, id: string): void;
  setNotesOpen(open: boolean): void;
  newChat(projectId?: string, text?: string): string;
  sendDraft(threadId: string, text: string): void;
  moveDraft(threadId: string, projectId: string): void;
  addProject(input: { name: string; path: string; source: Project["source"] }): Project;
  openNewProject(open: boolean): void;
  setAssistant(threadId: string, on: boolean): void;
  setConnector(threadId: string, connector: "telegram" | "slack", on: boolean): void;
  openAssistantSheet(threadId: string | null): void;
  setTelegramLinked(on: boolean): void;
  approve(threadId: string): void;
  answer(threadId: string, option: string): void;
  askAssistant(text: string): void;
  markRead(id: string): void;
  markAllRead(): void;
  dismiss(id: string): void;
  toast(title: string, description?: string): void;
  dismissToast(id: number): void;
}

let nextId = 1;
const uid = (prefix: string) => `${prefix}-${nextId++}`;

function projectFromPath(projects: ReadonlyArray<Project>, path: string): Project | undefined {
  return projects.find((p) => p.path === path);
}

export const useProto = create<ProtoState>((set, get) => ({
  screen: { kind: "home" },
  focus: "a",
  newVariant: "a1",
  assistantVariant: "b1",
  inboxVariant: "c2",
  notesOpen: true,

  projects: PROJECTS,
  threads: THREADS,
  inbox: INBOX,
  toasts: [],

  newProjectOpen: false,
  assistantSheet: null,
  telegramLinked: true,

  go: (screen) => {
    set({ screen });
    if (screen.kind === "chat") {
      // Looking at a chat reads its finished/failed items (approvals stay).
      set((s) => ({
        threads: s.threads.map((t) => (t.id === screen.threadId ? { ...t, unseen: false } : t)),
        inbox: s.inbox.map((i) =>
          i.threadId === screen.threadId && (i.kind === "done" || i.kind === "failed") ? { ...i, read: true } : i,
        ),
      }));
    }
  },

  setVariant: (section, id) => {
    set((s) => ({
      // A chat made an assistant in B2 goes back to normal in B1/B3.
      threads:
        section === "b"
          ? s.threads.map((t) => {
              const orig = THREADS.find((o) => o.id === t.id);
              return orig
                ? { ...t, assistant: orig.assistant ?? false, pinned: orig.pinned, connectors: orig.connectors ?? [] }
                : t;
            })
          : s.threads,
    }));
    set({
      focus: section,
      toasts: [],
      newProjectOpen: false,
      assistantSheet: null,
      ...(section === "a" ? { newVariant: id as NewVariant } : {}),
      ...(section === "b" ? { assistantVariant: id as AssistantVariant } : {}),
      ...(section === "c" ? { inboxVariant: id as InboxVariant } : {}),
    });
    // Land each section on a screen where its difference is visible.
    if (section === "b") {
      const v = id as AssistantVariant;
      get().go(v === "b3" ? { kind: "settings-telegram" } : { kind: "chat", threadId: ASSISTANT_ID });
    } else if (section === "c") {
      get().go(id === "c1" ? { kind: "inbox" } : { kind: "home" });
    } else {
      get().go({ kind: "home" });
    }
  },

  setNotesOpen: (open) => set({ notesOpen: open }),

  newChat: (projectId = HOME_PROJECT_ID, text = "") => {
    // Like the real app: an empty unsent chat is reused, not stacked.
    const empty = get().threads.find((t) => t.draft && t.messages.length === 0);
    if (empty) {
      set((s) => ({ threads: s.threads.map((t) => (t.id === empty.id ? { ...t, projectId } : t)) }));
      if (text) get().sendDraft(empty.id, text);
      get().go({ kind: "chat", threadId: empty.id });
      return empty.id;
    }
    const id = uid("draft");
    const thread: Thread = {
      id,
      title: "New chat",
      projectId,
      status: "idle",
      unseen: false,
      updatedMin: 0,
      pinned: false,
      draft: true,
      messages: text ? [] : [],
    };
    set((s) => ({ threads: [thread, ...s.threads] }));
    if (text) get().sendDraft(id, text);
    get().go({ kind: "chat", threadId: id });
    return id;
  },

  sendDraft: (threadId, text) => {
    const title = text.length > 42 ? `${text.slice(0, 40)}…` : text;
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              title: t.draft ? title : t.title,
              draft: false,
              status: "working",
              updatedMin: 0,
              messages: [...t.messages, { id: uid("m"), role: "user", text }],
            }
          : t,
      ),
    }));
    setTimeout(() => {
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId
            ? {
                ...t,
                status: "done",
                messages: [
                  ...t.messages,
                  { id: uid("m"), role: "assistant", text: "On it — this is a prototype, so the answer stops here." },
                ],
              }
            : t,
        ),
      }));
    }, 1400);
  },

  moveDraft: (threadId, projectId) =>
    set((s) => ({ threads: s.threads.map((t) => (t.id === threadId ? { ...t, projectId } : t)) })),

  addProject: ({ name, path, source }) => {
    const existing = projectFromPath(get().projects, path);
    if (existing) return existing;
    const tints = ["bg-rose-500/12 text-rose-600", "bg-amber-500/12 text-amber-600", "bg-violet-500/12 text-violet-600"];
    const project: Project = {
      id: uid("p"),
      name,
      path,
      glyph: name.slice(0, 1).toUpperCase(),
      tint: tints[get().projects.length % tints.length]!,
      ...(source ? { source } : {}),
    };
    set((s) => ({ projects: [...s.projects, project] }));
    return project;
  },

  openNewProject: (open) => set({ newProjectOpen: open }),

  setAssistant: (threadId, on) => {
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, assistant: on, pinned: on ? true : t.pinned, connectors: on ? t.connectors ?? [] : [] } : t,
      ),
    }));
    get().toast(
      on ? "This chat is now an assistant" : "No longer an assistant",
      on ? "Pinned to the top. Connect Telegram or Slack from its header." : "Telegram and Slack were disconnected.",
    );
  },

  setConnector: (threadId, connector, on) => {
    set((s) => ({
      threads: s.threads.map((t) => {
        if (t.id !== threadId) return t;
        const list = new Set(t.connectors ?? []);
        if (on) list.add(connector);
        else list.delete(connector);
        return { ...t, connectors: [...list] };
      }),
    }));
    get().toast(
      on ? `${connector === "telegram" ? "Telegram" : "Slack"} connected` : `${connector === "telegram" ? "Telegram" : "Slack"} disconnected`,
      on ? (connector === "telegram" ? "Write to @uno_misha_bot — it lands in this chat." : "Mention @Uno in #general — it lands in this chat.") : undefined,
    );
  },

  openAssistantSheet: (threadId) => set({ assistantSheet: threadId }),
  setTelegramLinked: (on) => set({ telegramLinked: on }),

  approve: (threadId) => {
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              status: "done",
              approval: undefined,
              messages: [
                ...t.messages,
                { id: uid("m"), role: "tool", text: "Ran npm run build && uno sites publish landing" },
                { id: uid("m"), role: "assistant", text: "Published: https://landing.uno4.site — build 14 s." },
              ],
            }
          : t,
      ),
      inbox: s.inbox.map((i) => (i.threadId === threadId && i.kind === "approval" ? { ...i, read: true, kind: "done", detail: "Approved and published" } : i)),
    }));
  },

  answer: (threadId, option) => {
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              status: "working",
              question: undefined,
              messages: [...t.messages, { id: uid("m"), role: "user", text: option }],
            }
          : t,
      ),
      inbox: s.inbox.map((i) => (i.threadId === threadId && i.kind === "input" ? { ...i, read: true, kind: "done", detail: `Answered: ${option}` } : i)),
    }));
  },

  askAssistant: (text) => {
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === ASSISTANT_ID ? { ...t, messages: [...t.messages, { id: uid("m"), role: "user", text }] } : t,
      ),
    }));
    setTimeout(() => {
      const chatId = uid("spawned");
      const title = text.length > 36 ? `${text.slice(0, 34)}…` : text;
      set((s) => ({
        threads: [
          ...s.threads.slice(0, 1),
          {
            id: chatId,
            title,
            projectId: HOME_PROJECT_ID,
            status: "working" as const,
            unseen: false,
            updatedMin: 0,
            pinned: false,
            spawnedBy: ASSISTANT_ID,
            messages: [{ id: uid("m"), role: "user" as const, text }],
          },
          ...s.threads.slice(1),
        ].map((t) =>
          t.id === ASSISTANT_ID
            ? {
                ...t,
                messages: [
                  ...t.messages,
                  { id: uid("m"), role: "assistant" as const, text: "Started a chat for it — I'll tell you here (and in Telegram) when it's done." },
                  { id: uid("m"), role: "spawn" as const, text: title, ref: chatId },
                ],
              }
            : t,
        ),
      }));
    }, 900);
  },

  markRead: (id) => set((s) => ({ inbox: s.inbox.map((i) => (i.id === id ? { ...i, read: true } : i)) })),
  markAllRead: () => set((s) => ({ inbox: s.inbox.map((i) => (i.kind === "approval" || i.kind === "input" ? i : { ...i, read: true })) })),
  dismiss: (id) => set((s) => ({ inbox: s.inbox.filter((i) => i.id !== id) })),

  toast: (title, description) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, title, ...(description ? { description } : {}) }] }));
    setTimeout(() => get().dismissToast(id), 3200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function useProject(id: string): Project {
  return useProto((s) => s.projects.find((p) => p.id === id) ?? s.projects[0]!);
}

export function useInboxCounts() {
  const inbox = useProto((s) => s.inbox);
  const needsYou = inbox.filter((i) => (i.kind === "approval" || i.kind === "input") && !i.read).length;
  const unread = inbox.filter((i) => !i.read).length;
  return { needsYou, unread };
}
