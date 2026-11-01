/**
 * The import of chats from a connected computer, in plain async code; the Effect
 * service only wires it to the daemon.
 *
 * Quietly scans, offers, and creates a chat per session through the ordinary
 * command path (`project.create`, `thread.create`, `thread.snooze`), so a chat
 * here is an ordinary chat with a `source`. Only titles, folders and times; the
 * history comes when the chat is opened.
 *
 * One record per computer in `<state>/my-computer/<id>/import.json`: what was
 * imported (computer + program + session id), so a second scan creates nothing
 * twice, a chat the person deleted stays deleted and a title they changed stays.
 * Nothing is written there until they agree to import.
 *
 * @module myComputer/import/chatImport
 */
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SNOOZED_UNTIL_OPENED,
  ThreadId,
  type ImportedChatTool,
  type ModelSelection,
  type MyComputerChatHistory,
  type MyComputerImportStatus,
  type OrchestrationCommand,
  type ThreadComputerSource,
} from "@t3tools/contracts";

import type { MyComputerCore } from "../myComputerCore.ts";
import {
  chatFingerprint,
  historyCachePath,
  loadChatHistory,
  readHistoryCache,
  safeSegment,
  writeJsonPrivately,
} from "./chatHistory.ts";
import {
  probeComputer,
  scanComputer,
  type ComputerProbe,
  type ScannedChat,
  type ScanResult,
} from "./chatScan.ts";
import { computerAccess, isFileFailure, isMissingFile } from "./computerAccess.ts";
import { toolName } from "./sessionText.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many chats between saves of the record: a crash repeats no more than this. */
const SAVE_EVERY = 25;
const PROBE_TTL_MS = 5 * 60 * 1000;
const NO_FOLDER_PROJECT = "Other chats";

const DRIVER_OF_TOOL: Readonly<Record<ImportedChatTool, string>> = {
  claude: "claudeAgent",
  codex: "codex",
  opencode: "opencode",
};

/** The model only picks the chat's icon until M5 and M6 continue such a chat. */
function modelFor(tool: ImportedChatTool): ModelSelection {
  const driver = DRIVER_OF_TOOL[tool];
  return {
    instanceId: ProviderInstanceId.make(driver),
    model: DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make(driver)] ?? "default",
  };
}

const hash = (...parts: ReadonlyArray<string>) =>
  Crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);

export const importedThreadId = (computerId: string, tool: string, sessionId: string) =>
  ThreadId.make(`imported-${hash(computerId, tool, sessionId)}`);

const chatKey = (tool: string, sessionId: string) => `${tool}:${sessionId}`;

/** Last folder name; Windows paths too, whatever this computer runs. */
export function projectTitle(cwd: string | null): string {
  if (cwd === null) return NO_FOLDER_PROJECT;
  const parts = cwd.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts.at(-1)?.replace(/:$/, "") || cwd;
}

interface ImportedChat {
  readonly threadId: string;
  readonly fingerprint: string;
  /** The title the session had: a different title on the thread is the person's. */
  readonly title: string;
  readonly chat: ScannedChat;
}

interface ImportRecord {
  declined: boolean;
  chats: Record<string, ImportedChat>;
  projects: Record<string, string>;
}

const emptyRecord = (): ImportRecord => ({ declined: false, chats: {}, projects: {} });

export interface ThreadView {
  readonly title: string;
  readonly snoozedUntil: string | null;
  readonly source: ThreadComputerSource | null;
}

export type ImportCommand = Extract<
  OrchestrationCommand,
  {
    readonly type:
      | "project.create"
      | "thread.create"
      | "thread.snooze"
      | "thread.unsnooze"
      | "thread.source.update";
  }
>;

export interface ChatImportDeps {
  readonly stateDir: string;
  readonly baseDir: string;
  readonly core: MyComputerCore;
  readonly dispatch: (command: ImportCommand) => Promise<void>;
  readonly getThread: (threadId: string) => Promise<ThreadView | null>;
  readonly projectExists: (projectId: string) => Promise<boolean>;
  readonly now?: () => Date;
  readonly warn?: (message: string) => void;
}

interface ComputerJob {
  state: MyComputerImportStatus["state"];
  scan: ScanResult | null;
  scanned: { done: number; total: number };
  progress: { done: number; total: number };
  result: MyComputerImportStatus["result"];
  message: string | null;
}

const newJob = (): ComputerJob => ({
  state: "idle",
  scan: null,
  scanned: { done: 0, total: 0 },
  progress: { done: 0, total: 0 },
  result: null,
  message: null,
});

export interface ChatImport {
  readonly status: (computerId: string) => Promise<MyComputerImportStatus>;
  readonly scan: (computerId: string) => Promise<MyComputerImportStatus>;
  readonly start: (
    computerId: string,
    tools: ReadonlyArray<ImportedChatTool>,
  ) => Promise<MyComputerImportStatus>;
  readonly decline: (computerId: string) => Promise<MyComputerImportStatus>;
  readonly history: (threadId: string) => Promise<MyComputerChatHistory>;
}

export function createChatImport(deps: ChatImportDeps): ChatImport {
  const now = deps.now ?? (() => new Date());
  const jobs = new Map<string, ComputerJob>();
  const records = new Map<string, ImportRecord>();
  const probes = new Map<string, { readonly probe: ComputerProbe; readonly at: number }>();
  const histories = new Map<string, Promise<MyComputerChatHistory>>();
  const commandId = (what: string) =>
    CommandId.make(`my-computer-import:${what}:${Crypto.randomUUID()}`);

  const jobOf = (computerId: string) => {
    const job = jobs.get(computerId) ?? newJob();
    jobs.set(computerId, job);
    return job;
  };

  const recordPath = (computerId: string) =>
    Path.join(deps.stateDir, "my-computer", safeSegment(computerId), "import.json");

  const recordOf = async (computerId: string): Promise<ImportRecord> => {
    const held = records.get(computerId);
    if (held !== undefined) return held;
    let loaded = emptyRecord();
    try {
      const parsed = JSON.parse(await Fs.readFile(recordPath(computerId), "utf8")) as ImportRecord;
      loaded = { ...emptyRecord(), ...parsed };
    } catch {
      // No record yet.
    }
    records.set(computerId, loaded);
    return loaded;
  };

  const saveRecord = (computerId: string, record: ImportRecord) =>
    writeJsonPrivately(recordPath(computerId), record);

  const probeOf = async (
    computerId: string,
    access: ReturnType<typeof computerAccess>,
  ): Promise<ComputerProbe> => {
    const held = probes.get(computerId);
    if (held !== undefined && Date.now() - held.at < PROBE_TTL_MS) return held.probe;
    const probe = await probeComputer(access);
    probes.set(computerId, { probe, at: Date.now() });
    return probe;
  };

  const statusOf = async (computerId: string): Promise<MyComputerImportStatus> => {
    const job = jobOf(computerId);
    const record = await recordOf(computerId);
    const imported = Object.values(record.chats);
    const tools = (job.scan?.tools ?? []).flatMap((scan) => {
      if (scan.chats.length === 0 && scan.available) return [];
      const newChats = scan.chats.filter(
        (chat) => record.chats[chatKey(chat.tool, chat.sessionId)] === undefined,
      );
      return [
        {
          id: scan.tool,
          name: toolName(scan.tool),
          chats: scan.chats.length,
          newChats: newChats.length,
          // The offer counts what it's about to bring: the new chats' projects.
          projects: new Set(newChats.map((chat) => chat.cwd)).size,
          available: scan.available,
          unavailableReason: scan.unavailableReason,
        },
      ];
    });
    return {
      computerId,
      state: job.state,
      declined: record.declined,
      tools,
      alsoFound: job.scan?.alsoFound ?? [],
      skipped: job.scan?.skipped ?? { unreadable: 0, unknownFormat: 0 },
      scanned: { ...job.scanned },
      progress: { ...job.progress },
      result: job.result,
      importedChats: imported.length,
      importedProjects: new Set(imported.map((entry) => entry.chat.cwd)).size,
      message: job.message,
    };
  };

  const toSource = (
    computerId: string,
    computerName: string,
    chat: ScannedChat,
  ): ThreadComputerSource => ({
    kind: "computer",
    computerId,
    computerName,
    tool: chat.tool,
    sessionId: chat.sessionId,
    path: chat.path,
    cwd: chat.cwd,
    lastActiveAt: chat.lastActiveAt,
  });

  const computerName = async (computerId: string) => {
    const status = await deps.core.status();
    const computer = status.computers.find((item) => item.id === computerId);
    return { name: computer?.name || computerId, online: computer?.online === true };
  };

  /**
   * Chats already imported that changed on the computer: the list follows, and
   * a chat that came alive leaves Snoozed. The history is re-read on opening.
   */
  const applyChanges = async (computerId: string, scan: ScanResult) => {
    const record = await recordOf(computerId);
    const { name } = await computerName(computerId);
    let changed = false;
    for (const toolScan of scan.tools) {
      for (const chat of toolScan.chats) {
        const entry = record.chats[chatKey(chat.tool, chat.sessionId)];
        if (entry === undefined || entry.fingerprint === chat.fingerprint) continue;
        const threadId = ThreadId.make(entry.threadId);
        const thread = await deps.getThread(entry.threadId);
        // Deleted here: it stays deleted, the record remembers why.
        if (thread !== null) {
          const titleIsOurs = thread.title === entry.title && chat.title !== entry.title;
          await deps.dispatch({
            type: "thread.source.update",
            commandId: commandId("update"),
            threadId,
            source: toSource(computerId, name, chat),
            ...(titleIsOurs ? { title: chat.title } : {}),
          });
          const recent = now().getTime() - Date.parse(chat.lastActiveAt) <= DAY_MS;
          if (recent && thread.snoozedUntil === SNOOZED_UNTIL_OPENED) {
            await deps.dispatch({
              type: "thread.unsnooze",
              commandId: commandId("wake"),
              threadId,
              reason: "user",
            });
          }
        }
        record.chats[chatKey(chat.tool, chat.sessionId)] = {
          ...entry,
          fingerprint: chat.fingerprint,
          title: chat.title,
          chat,
        };
        changed = true;
      }
    }
    if (changed) await saveRecord(computerId, record);
  };

  const runScan = async (computerId: string) => {
    const job = jobOf(computerId);
    const access = computerAccess(deps.core, computerId);
    try {
      await deps.core.note(computerId, "list", "session files of Claude Code, Codex and OpenCode");
      const record = await recordOf(computerId);
      const scan = await scanComputer({
        access,
        known: ({ tool, sessionId, fingerprint }) => {
          const entry = record.chats[chatKey(tool, sessionId)];
          return entry?.fingerprint === fingerprint ? entry.chat : null;
        },
        onProgress: (done, total) => {
          job.scanned = { done, total };
        },
      });
      await applyChanges(computerId, scan);
      job.scan = scan;
      job.state = "ready";
    } catch (cause) {
      job.state = "failed";
      job.message = isFileFailure(cause)
        ? "Couldn't read this computer."
        : "Couldn't finish looking for chats: the computer stopped answering.";
      deps.warn?.(`chat import scan failed for ${computerId}`);
    }
  };

  const projectFor = async (
    computerId: string,
    record: ImportRecord,
    cwd: string | null,
  ): Promise<ProjectId> => {
    const key = cwd ?? "";
    const held = record.projects[key];
    if (held !== undefined && (await deps.projectExists(held))) return ProjectId.make(held);
    const base = `imported-${hash(computerId, key)}`;
    // Removed here and wanted again: a removed project's id can't come back.
    const id = held === undefined ? base : `${base}-${now().getTime()}`;
    if (!(await deps.projectExists(id))) {
      // An empty folder: the chat ran on the computer, there are no files here yet.
      const workspaceRoot = Path.join(deps.baseDir, "imported", safeSegment(computerId), id);
      await Fs.mkdir(workspaceRoot, { recursive: true });
      await deps.dispatch({
        type: "project.create",
        commandId: commandId("project"),
        projectId: ProjectId.make(id),
        title: projectTitle(cwd),
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
        createdAt: now().toISOString(),
      });
    }
    record.projects[key] = id;
    return ProjectId.make(id);
  };

  const runImport = async (computerId: string, chats: ReadonlyArray<ScannedChat>) => {
    const job = jobOf(computerId);
    const record = await recordOf(computerId);
    let recent = 0;
    let snoozed = 0;
    let failed = 0;
    try {
      const { name } = await computerName(computerId);
      record.declined = false;
      for (const chat of chats) {
        const key = chatKey(chat.tool, chat.sessionId);
        const threadId = importedThreadId(computerId, chat.tool, chat.sessionId);
        try {
          // A crash after the dispatch and before the save lands here on resume.
          if ((await deps.getThread(threadId)) === null) {
            const projectId = await projectFor(computerId, record, chat.cwd);
            await deps.dispatch({
              type: "thread.create",
              commandId: commandId("thread"),
              threadId,
              projectId,
              title: chat.title,
              modelSelection: modelFor(chat.tool),
              runtimeMode: "approval-required",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              source: toSource(computerId, name, chat),
              createdAt: chat.startedAt,
            });
            if (now().getTime() - Date.parse(chat.lastActiveAt) > DAY_MS) {
              await deps.dispatch({
                type: "thread.snooze",
                commandId: commandId("snooze"),
                threadId,
                snoozedUntil: SNOOZED_UNTIL_OPENED,
              });
              snoozed += 1;
            } else {
              recent += 1;
            }
          }
          record.chats[key] = {
            threadId,
            fingerprint: chat.fingerprint,
            title: chat.title,
            chat,
          };
        } catch {
          failed += 1;
        }
        job.progress = { done: job.progress.done + 1, total: job.progress.total };
        if (job.progress.done % SAVE_EVERY === 0) await saveRecord(computerId, record);
      }
      await saveRecord(computerId, record);
      job.result = { imported: recent + snoozed, recent, snoozed, failed };
      job.state = "done";
    } catch {
      job.state = "failed";
      job.message = "The import stopped. Start it again: nothing is imported twice.";
      deps.warn?.(`chat import failed for ${computerId}`);
    }
  };

  const fail = (message: string): MyComputerChatHistory => ({ kind: "failed", message });

  const loadHistory = async (threadId: string): Promise<MyComputerChatHistory> => {
    const thread = await deps.getThread(threadId);
    const source = thread?.source ?? null;
    if (source === null) return fail("This chat wasn't imported from a computer.");
    const { computerId } = source;
    const cachePath = historyCachePath(
      deps.stateDir,
      computerId,
      hash(source.tool, source.sessionId),
    );
    const cached = await readHistoryCache(cachePath);
    const ready = (stale: boolean) =>
      cached === null
        ? null
        : ({
            kind: "ready",
            messages: cached.messages,
            truncated: cached.truncated,
            stale,
          } as const);
    const offline = (): MyComputerChatHistory =>
      ready(true) ?? { kind: "offline", computerName: source.computerName };

    let online: boolean;
    try {
      online = (await computerName(computerId)).online;
    } catch {
      return offline();
    }
    if (!online) return offline();

    const access = computerAccess(deps.core, computerId);
    try {
      const probe = await probeOf(computerId, access);
      const fingerprint = await chatFingerprint(access, probe, source);
      if (fingerprint === null) return ready(true) ?? { kind: "gone" };
      if (cached?.fingerprint === fingerprint) return ready(false)!;
      await deps.core.note(computerId, "read", `a chat: ${source.path}`, threadId);
      const loaded = await loadChatHistory(access, probe, source);
      await writeJsonPrivately(cachePath, { ...loaded, fingerprint });
      return {
        kind: "ready",
        messages: loaded.messages,
        truncated: loaded.truncated,
        stale: false,
      };
    } catch (cause) {
      if (isMissingFile(cause)) return ready(true) ?? { kind: "gone" };
      if (isFileFailure(cause)) return ready(true) ?? fail("Couldn't read this chat.");
      if (cause instanceof Error && !("kind" in cause)) {
        return ready(true) ?? fail(cause.message);
      }
      return offline();
    }
  };

  return {
    status: statusOf,
    scan: async (computerId) => {
      const job = jobOf(computerId);
      if (job.state !== "scanning" && job.state !== "importing") {
        job.state = "scanning";
        job.message = null;
        job.result = null;
        job.scanned = { done: 0, total: 0 };
        job.progress = { done: 0, total: 0 };
        void runScan(computerId);
      }
      return statusOf(computerId);
    },
    start: async (computerId, tools) => {
      const job = jobOf(computerId);
      if (job.state === "importing") return statusOf(computerId);
      if (job.scan === null) {
        throw new Error("Nothing to import yet: the search for chats hasn't finished.");
      }
      const record = await recordOf(computerId);
      const wanted = new Set(tools);
      const chats = job.scan.tools
        .filter((scan) => wanted.has(scan.tool))
        .flatMap((scan) => scan.chats)
        .filter((chat) => record.chats[chatKey(chat.tool, chat.sessionId)] === undefined)
        .toSorted((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
      job.state = "importing";
      job.result = null;
      job.message = null;
      job.progress = { done: 0, total: chats.length };
      void runImport(computerId, chats);
      return statusOf(computerId);
    },
    decline: async (computerId) => {
      const record = await recordOf(computerId);
      record.declined = true;
      await saveRecord(computerId, record);
      return statusOf(computerId);
    },
    history: (threadId) => {
      const running = histories.get(threadId);
      if (running !== undefined) return running;
      const loading = loadHistory(threadId).finally(() => histories.delete(threadId));
      histories.set(threadId, loading);
      return loading;
    },
  };
}
