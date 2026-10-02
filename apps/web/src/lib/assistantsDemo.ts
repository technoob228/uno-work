/**
 * Demo account for assistants on a local stand (no Uno account, no console):
 * only in builds made with `VITE_ASSISTANTS_DEMO=1`, so it is compiled out of
 * releases. "Creating a computer" hands back the computer this page talks to;
 * the files, the assistant and its chat are real, the account is not.
 */
import {
  promptFromCommand,
  type ConnectorLevel,
  type ConnectorProvider,
} from "../components/assistants/assistantTemplates";
import type {
  AssistantComputer,
  AssistantSchedule,
  ConnectorPermissionsState,
} from "./assistantsConsoleApi";

export const isAssistantsDemo: boolean = import.meta.env.VITE_ASSISTANTS_DEMO === "1";

const KEY = "uno.assistants-demo.v1";

interface DemoState {
  computers: AssistantComputer[];
  permissions: Record<number, Partial<Record<ConnectorProvider, ConnectorLevel>>>;
  schedules: AssistantSchedule[];
  nextId: number;
}

function load(): DemoState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as DemoState;
  } catch {
    // fresh state
  }
  return { computers: [], permissions: {}, schedules: [], nextId: 9001 };
}

function save(state: DemoState) {
  window.localStorage.setItem(KEY, JSON.stringify(state));
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const assistantsDemo = {
  // Computers saved before deletion existed have no deletedAt: read as live.
  listComputers: async (): Promise<ReadonlyArray<AssistantComputer>> => load().computers,
  addComputer: async (
    computer: Omit<AssistantComputer, "boxId" | "deletedAt" | "purgeAt">,
  ): Promise<number> => {
    await wait(1200);
    const state = load();
    const boxId = state.nextId++;
    state.computers.push({ ...computer, boxId, deletedAt: null, purgeAt: null });
    save(state);
    return boxId;
  },
  // Like the console: a deleted assistant is kept for 7 days and can come back.
  deleteComputer: async (boxId: number) => {
    const state = load();
    const now = Date.now();
    state.computers = state.computers.map((computer) =>
      computer.boxId === boxId && !computer.deletedAt
        ? {
            ...computer,
            deletedAt: new Date(now).toISOString(),
            purgeAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
          }
        : computer,
    );
    save(state);
  },
  restoreComputer: async (boxId: number) => {
    const state = load();
    state.computers = state.computers.map((computer) =>
      computer.boxId === boxId ? { ...computer, deletedAt: null, purgeAt: null } : computer,
    );
    save(state);
  },
  getPermissions: async (boxId: number): Promise<ConnectorPermissionsState> => {
    const stored = load().permissions[boxId] ?? {};
    const permissions = {
      gmail: stored.gmail ?? "write",
      "google-drive": stored["google-drive"] ?? "write",
      notion: stored.notion ?? "write",
      github: stored.github ?? "write",
    } as const;
    return { supported: true, restricted: Object.keys(stored).length > 0, permissions };
  },
  putPermissions: async (
    boxId: number,
    permissions: Partial<Record<ConnectorProvider, ConnectorLevel>>,
  ): Promise<boolean> => {
    const state = load();
    state.permissions[boxId] = { ...permissions };
    save(state);
    return true;
  },
  listSchedules: async (boxId: number): Promise<ReadonlyArray<AssistantSchedule>> =>
    load().schedules.filter((task) => task.name.endsWith(`#${boxId}`)),
  createSchedule: async (input: {
    boxId: number;
    name: string;
    cron: string;
    command: string;
    timezone: string;
  }) => {
    const state = load();
    state.schedules.push({
      id: state.nextId++,
      name: `${input.name} #${input.boxId}`,
      cron: input.cron,
      timezone: input.timezone,
      prompt: promptFromCommand(input.command),
      command: input.command,
      state: "active",
      nextRunAt: null,
    });
    save(state);
  },
  deleteSchedule: async (id: number) => {
    const state = load();
    state.schedules = state.schedules.filter((task) => task.id !== id);
    save(state);
  },
};
