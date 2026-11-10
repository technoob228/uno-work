/**
 * This computer's half of moving an assistant (`@t3tools/shared/assistantMove`):
 *
 * - as the **source**: `exportBundle` (its folder, state, channels, pending
 *   reminders, a text copy of its chats), `release` (it stops answering here:
 *   channels off and kept; a named assistant goes to Deleted, kept 7 days;
 *   Uno — every computer's own — stays, without channels, marked "moved to"),
 *   `unrelease` (the rollback of release);
 * - as the **target**: `importBundle` (staged: everything but the channels;
 *   this computer's own Uno is put aside first when Uno moves in),
 *   `activate` (channels on, reminders back, "moved in" mark), `discard`
 *   (the rollback of import + activate: what was here comes back).
 *
 * Every step is recorded in `<state>/assistants/moves.json`
 * (`assistantMoveFiles.ts`) before it is taken, so a rollback knows exactly
 * what to undo. Uno's shared bot / Slack app (a console relay) is bound to
 * the computer it was linked on: it is not carried over — the target links
 * it again (`relink`).
 *
 * @module assistants/assistantMoveOps
 */
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import {
  ASSISTANT_PROJECT_ID,
  assistantTokenLabel,
  CommandId,
  isAssistantProjectId,
  ManagerSlackConnectorConfig,
  ManagerTelegramConnectorConfig,
  ModelSelection,
  ProjectId,
  Reminder,
  ThreadId,
} from "@t3tools/contracts";
import {
  ASSISTANT_MOVE_BUNDLE_VERSION,
  type AssistantMoveActivateResult,
  type AssistantMoveBundle,
  type AssistantMoveComputer,
  type AssistantMoveConnector,
  type AssistantMoveImportResult,
  type AssistantMoveReminder,
} from "@t3tools/shared/assistantMove";
import { Data, Effect, Option, Schema } from "effect";

import { ServerConfig } from "../config.ts";
import { isRelayCredential, isRouteCredential } from "../manager/channelRelay.ts";
import { ManagerAssistantService } from "../manager/Services/AssistantService.ts";
import { assistantCommandOrigin } from "../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerCapabilityTokenRepository } from "../persistence/Services/ManagerCapabilityTokens.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { RemindersRepository } from "../persistence/Services/Reminders.ts";
import { resolveAssistantsDir } from "./assistantsDir.ts";
import {
  assistantStateDir,
  collectFiles,
  type ConnectorRowCopy,
  historyFiles,
  type HistoryChat,
  type IncomingMove,
  MOVE_HISTORY_MAX_CHATS,
  MOVE_TOTAL_LIMIT_BYTES,
  moveBackupDir,
  putAside,
  readMoves,
  updateMoves,
  writeFiles,
} from "./assistantMoveFiles.ts";
import { dropDeletedAssistant, readDeletedAssistants } from "./localAssistantStore.ts";

export class AssistantMoveOpError extends Data.TaggedError("AssistantMoveOpError")<{
  readonly message: string;
  readonly status: number;
}> {}

const refuse = (message: string, status = 409) => new AssistantMoveOpError({ message, status });

const CONNECTOR_KINDS = ["telegram", "slack"] as const;

/** Whether a connector row talks through Uno's console relay (bound to this computer). */
function connectorVia(kind: "telegram" | "slack", config: unknown): "own" | "relay" | null {
  const decoded =
    kind === "telegram"
      ? Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(config)
      : Schema.decodeUnknownExit(ManagerSlackConnectorConfig)(config);
  if (decoded._tag !== "Success") return null;
  const token = decoded.value.botToken;
  return isRelayCredential(token) || isRouteCredential(token) ? "relay" : "own";
}

const pathExists = (path: string) =>
  fsp
    .access(path)
    .then(() => true)
    .catch(() => false);

/** Reads an assistant folder's marker; only a folder that says it is this assistant is ever removed. */
async function isOwnedFolder(root: string, projectId: string): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await fsp.readFile(nodePath.join(root, ".uno-assistant.json"), "utf8"),
    );
    return marker?.projectId === projectId;
  } catch {
    return false;
  }
}

export const makeAssistantMoveOps = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const projections = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const assistants = yield* ManagerAssistantService;
  const connectors = yield* ManagerConnectorRepository;
  const tokens = yield* ManagerCapabilityTokenRepository;
  const reminders = yield* Effect.serviceOption(RemindersRepository);
  const trashDir = nodePath.join(resolveAssistantsDir(os.homedir()), ".trash");

  const failWith = (message: string) => (cause: unknown) =>
    refuse(
      `${message}${cause instanceof Error && cause.message ? ` (${cause.message})` : ""}`,
      500,
    );

  const promise = <A>(message: string, task: () => Promise<A>) =>
    Effect.tryPromise({ try: task, catch: failWith(message) });

  const projectOf = (projectId: string) =>
    projections
      .getProjectShellById(ProjectId.make(projectId))
      .pipe(Effect.mapError(failWith("Couldn't read the assistant's project")));

  const pendingReminders = (projectId: string) =>
    Effect.gen(function* () {
      if (Option.isNone(reminders)) return [] as ReadonlyArray<AssistantMoveReminder>;
      const rows = yield* reminders.value
        .list({ includeInactive: false })
        .pipe(Effect.orElseSucceed(() => []));
      return rows
        .filter((row) => row.projectId === projectId && row.status === "pending")
        .map(
          (row): AssistantMoveReminder => ({
            reminderId: row.reminderId,
            chatId: row.chatId,
            message: row.message,
            dueAt: row.dueAt,
            createdAt: row.createdAt,
            createdBy: row.createdBy,
            connector: row.connector,
          }),
        );
    });

  /** Makes them again here under fresh ids (the old rows stay cancelled); returns the ids. */
  const insertReminders = (projectId: string, list: ReadonlyArray<AssistantMoveReminder>) =>
    Effect.gen(function* () {
      if (Option.isNone(reminders)) return [] as string[];
      const ids: string[] = [];
      for (const reminder of list) {
        const decoded = Schema.decodeUnknownOption(Reminder)({
          ...reminder,
          reminderId: `${reminder.reminderId.slice(0, 40)}-m${crypto.randomUUID().slice(0, 8)}`,
          projectId,
          status: "pending",
          deliveredAt: null,
          failureReason: null,
        });
        if (Option.isNone(decoded)) continue;
        const made = yield* reminders.value.create(decoded.value).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (made) ids.push(decoded.value.reminderId);
      }
      return ids;
    });

  const cancelReminders = (ids: ReadonlyArray<string>) =>
    Effect.forEach(
      ids,
      (reminderId) =>
        Option.isNone(reminders)
          ? Effect.void
          : reminders.value.cancel({ reminderId }).pipe(Effect.ignore),
      { discard: true },
    );

  const connectorRows = (projectId: string) =>
    Effect.gen(function* () {
      const rows: ConnectorRowCopy[] = [];
      for (const kind of CONNECTOR_KINDS) {
        const row = yield* connectors
          .get({ projectId: ProjectId.make(projectId), kind })
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(row)) rows.push({ kind, config: row.value.config });
      }
      return rows;
    });

  const putConnectorRow = (projectId: string, row: ConnectorRowCopy) =>
    connectors
      .upsert({
        projectId: ProjectId.make(projectId),
        kind: row.kind,
        config: row.config,
        updatedAt: new Date().toISOString(),
      })
      .pipe(Effect.mapError(failWith(`Couldn't save its ${row.kind}`)));

  const removeConnectorRow = (projectId: string, kind: "telegram" | "slack") =>
    connectors
      .remove({ projectId: ProjectId.make(projectId), kind })
      .pipe(Effect.mapError(failWith(`Couldn't turn its ${kind} off`)));

  const revokeToken = (projectId: string) =>
    Effect.gen(function* () {
      const token = yield* tokens
        .getActiveByLabel(assistantTokenLabel(ProjectId.make(projectId)))
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(token)) {
        yield* tokens
          .revoke({ tokenId: token.value.tokenId, revokedAt: new Date().toISOString() })
          .pipe(Effect.ignore);
      }
    });

  const setMeta = (projectId: string, input: { title: string; defaultModelSelection: unknown }) =>
    Effect.gen(function* () {
      const model = Schema.decodeUnknownOption(ModelSelection)(input.defaultModelSelection);
      yield* engine
        .dispatch(
          {
            type: "project.meta.update",
            commandId: CommandId.make(`assistant-move:${crypto.randomUUID()}`),
            projectId: ProjectId.make(projectId),
            ...(input.title.trim().length > 0 ? { title: input.title.trim() } : {}),
            ...(Option.isSome(model) ? { defaultModelSelection: model.value } : {}),
          },
          { origin: assistantCommandOrigin({ assistantKey: projectId }) },
        )
        .pipe(Effect.ignore);
    });

  // ── Source ──────────────────────────────────────────────────────────

  const exportBundle = (input: {
    readonly projectId: string;
    readonly name?: string | undefined;
    readonly computerName: string;
  }) =>
    Effect.gen(function* () {
      const { projectId } = input;
      if (!isAssistantProjectId(projectId)) return yield* refuse("Not an assistant.", 400);
      const project = yield* projectOf(projectId);
      if (Option.isNone(project))
        return yield* refuse("This assistant isn't on this computer.", 404);
      const deleted = yield* promise("Couldn't read deleted assistants", () =>
        readDeletedAssistants(config.stateDir),
      );
      if (deleted.some((record) => record.projectId === projectId)) {
        return yield* refuse("This assistant was deleted here; restore it first.", 409);
      }
      const moves = yield* promise("Couldn't read the moves", () => readMoves(config.stateDir));
      if (moves.outgoing[projectId] !== undefined && projectId === ASSISTANT_PROJECT_ID) {
        return yield* refuse(
          `Uno already moved from here to ${moves.outgoing[projectId]!.to.name}; move it from there.`,
          409,
        );
      }
      const name = input.name?.trim() || project.value.title;
      const now = new Date().toISOString();

      // A text copy of its chats goes into the folder (history/<computer>/).
      const snapshot = yield* projections
        .getShellSnapshot()
        .pipe(Effect.mapError(failWith("Couldn't read its chats")));
      const threads = snapshot.threads
        .filter(
          (thread) =>
            thread.projectId === projectId &&
            ((thread as { readonly deletedAt?: string | null }).deletedAt ?? null) === null,
        )
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MOVE_HISTORY_MAX_CHATS);
      const chats: HistoryChat[] = [];
      for (const thread of threads) {
        const detail = yield* projections
          .getThreadDetailById(thread.id)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(detail)) continue;
        chats.push({
          title: detail.value.title,
          createdAt: detail.value.createdAt,
          messages: detail.value.messages.map((message) => ({
            role: message.role,
            text: message.text,
            createdAt: message.createdAt,
          })),
        });
      }
      const history = historyFiles({
        assistantName: name,
        computerName: input.computerName,
        movedAt: now,
        chats,
      });
      const workspace = yield* promise("Couldn't read its folder", () =>
        collectFiles(project.value.workspaceRoot, { skipTop: ["history"] }),
      );
      const state = yield* promise("Couldn't read its settings", () =>
        collectFiles(assistantStateDir(config.stateDir, projectId), {
          budgetBytes: MOVE_TOTAL_LIMIT_BYTES - workspace.bytes,
        }),
      );
      // Copies from earlier moves (history/ of other computers) travel too.
      const earlierHistory = yield* promise("Couldn't read its history", () =>
        collectFiles(nodePath.join(project.value.workspaceRoot, "history"), {
          budgetBytes: MOVE_TOTAL_LIMIT_BYTES - workspace.bytes - state.bytes,
        }),
      );
      const ownHistoryPrefix = history.files[0]?.path.split("/").slice(0, 2).join("/") ?? null;
      const carriedHistory = earlierHistory.files
        .map((file) => ({ ...file, path: `history/${file.path}` }))
        .filter(
          (file) => ownHistoryPrefix === null || !file.path.startsWith(`${ownHistoryPrefix}/`),
        );

      const rows = yield* connectorRows(projectId);
      const moved: AssistantMoveConnector[] = [];
      for (const row of rows) {
        const via = connectorVia(row.kind, row.config);
        if (via !== null) moved.push({ kind: row.kind, config: row.config, via });
      }
      const pending = yield* pendingReminders(projectId);
      const bundle: AssistantMoveBundle = {
        version: ASSISTANT_MOVE_BUNDLE_VERSION,
        projectId,
        title: project.value.title,
        isUno: projectId === ASSISTANT_PROJECT_ID,
        exportedAt: now,
        defaultModelSelection: project.value.defaultModelSelection ?? null,
        workspace: [...workspace.files, ...carriedHistory, ...history.files],
        state: state.files,
        skipped: [
          ...workspace.skipped,
          ...state.skipped.map((entry) => ({ ...entry, path: `(settings) ${entry.path}` })),
          ...earlierHistory.skipped.map((entry) => ({ ...entry, path: `history/${entry.path}` })),
        ],
        connectors: moved,
        reminders: pending,
        historyChats: history.chats,
      };
      return bundle;
    });

  const release = (input: { readonly projectId: string; readonly to: AssistantMoveComputer }) =>
    Effect.gen(function* () {
      const { projectId } = input;
      const project = yield* projectOf(projectId);
      if (Option.isNone(project))
        return yield* refuse("This assistant isn't on this computer.", 404);
      const isUno = projectId === ASSISTANT_PROJECT_ID;
      const rows = yield* connectorRows(projectId);
      const pending = yield* pendingReminders(projectId);
      // Recorded first: a failure past this point is undone from the record.
      yield* promise("Couldn't record the move", () =>
        updateMoves(config.stateDir, (record) => ({
          ...record,
          outgoing: {
            ...record.outgoing,
            [projectId]: {
              projectId,
              to: input.to,
              at: new Date().toISOString(),
              isUno,
              deleted: !isUno,
              connectorRows: rows,
              reminders: pending,
            },
          },
        })),
      );
      yield* cancelReminders(pending.map((row) => row.reminderId));
      if (isUno) {
        // Every computer keeps a Uno; this one only stops answering its channels.
        for (const row of rows) yield* removeConnectorRow(projectId, row.kind);
      } else {
        // Its channels, chats and folder go aside the usual way (kept 7 days).
        yield* assistants
          .deleteAssistant(ProjectId.make(projectId))
          .pipe(Effect.mapError((error) => refuse(error.detail, 409)));
      }
      yield* Effect.logInfo("assistant moved away").pipe(
        Effect.annotateLogs({ projectId, to: input.to.name, boxId: input.to.boxId }),
      );
    });

  const unrelease = (projectId: string) =>
    Effect.gen(function* () {
      const moves = yield* promise("Couldn't read the moves", () => readMoves(config.stateDir));
      const record = moves.outgoing[projectId];
      if (record === undefined) return;
      if (record.deleted) {
        yield* assistants
          .restoreAssistant(ProjectId.make(projectId))
          .pipe(Effect.mapError((error) => refuse(error.detail, 409)));
      } else {
        for (const row of record.connectorRows) yield* putConnectorRow(projectId, row);
      }
      yield* insertReminders(projectId, record.reminders);
      yield* promise("Couldn't record the move", () =>
        updateMoves(config.stateDir, (current) => {
          const { [projectId]: _dropped, ...outgoing } = current.outgoing;
          return { ...current, outgoing };
        }),
      );
      yield* Effect.logInfo("assistant move undone on the source").pipe(
        Effect.annotateLogs({ projectId }),
      );
    });

  // ── Target ──────────────────────────────────────────────────────────

  const discard = (projectId: string) =>
    Effect.gen(function* () {
      const moves = yield* promise("Couldn't read the moves", () => readMoves(config.stateDir));
      const record = moves.incoming[projectId];
      if (record === undefined) return;
      for (const kind of record.activated) yield* removeConnectorRow(projectId, kind);
      yield* cancelReminders(record.reminderIds);
      const project = yield* projectOf(projectId);
      const root = Option.isSome(project) ? project.value.workspaceRoot : null;
      if (record.isUno && record.backup !== null) {
        const backup = record.backup;
        for (const row of backup.connectorRows) {
          if (record.activated.includes(row.kind)) yield* putConnectorRow(projectId, row);
        }
        yield* promise("Couldn't put this computer's Uno back", async () => {
          if (backup.workspaceBackup !== null) {
            if (await isOwnedFolder(backup.workspaceRoot, projectId)) {
              await fsp.rm(backup.workspaceRoot, { recursive: true, force: true });
            }
            await fsp.rename(backup.workspaceBackup, backup.workspaceRoot);
          }
          const stateDir = assistantStateDir(config.stateDir, projectId);
          await fsp.rm(stateDir, { recursive: true, force: true });
          if (backup.stateBackup !== null) await fsp.rename(backup.stateBackup, stateDir);
        });
        yield* revokeToken(projectId);
        yield* assistants
          .ensureAssistant({ projectId: ProjectId.make(projectId), title: backup.title })
          .pipe(Effect.mapError((error) => refuse(error.detail, 500)));
        yield* setMeta(projectId, {
          title: backup.title,
          defaultModelSelection: backup.defaultModelSelection,
        });
      } else if (record.created) {
        yield* revokeToken(projectId);
        if (Option.isSome(project)) {
          yield* engine
            .dispatch(
              {
                type: "project.delete",
                commandId: CommandId.make(`assistant-move-discard:${crypto.randomUUID()}`),
                projectId: ProjectId.make(projectId),
                force: true,
              },
              { origin: assistantCommandOrigin({ assistantKey: projectId }) },
            )
            .pipe(Effect.ignore);
        }
        yield* promise("Couldn't remove the copy", async () => {
          if (root !== null && (await isOwnedFolder(root, projectId))) {
            await fsp.rm(root, { recursive: true, force: true });
          }
          await fsp.rm(assistantStateDir(config.stateDir, projectId), {
            recursive: true,
            force: true,
          });
        });
      }
      yield* promise("Couldn't record the move", () =>
        updateMoves(config.stateDir, (current) => {
          const { [projectId]: _dropped, ...incoming } = current.incoming;
          return { ...current, incoming };
        }),
      );
      yield* Effect.logInfo("assistant move discarded on the target").pipe(
        Effect.annotateLogs({ projectId }),
      );
    });

  const importBundle = (input: {
    readonly bundle: AssistantMoveBundle;
    readonly from: AssistantMoveComputer;
  }) =>
    Effect.gen(function* () {
      const { bundle } = input;
      if (bundle.version !== ASSISTANT_MOVE_BUNDLE_VERSION) {
        return yield* refuse("This Uno Work is older than the other computer's; update it.", 409);
      }
      const projectId = bundle.projectId;
      if (
        !isAssistantProjectId(projectId) ||
        (projectId === ASSISTANT_PROJECT_ID) !== bundle.isUno
      ) {
        return yield* refuse("Not an assistant.", 400);
      }
      const isUno = bundle.isUno;
      // A move that stopped half-way here before is cleared first.
      const before = yield* promise("Couldn't read the moves", () => readMoves(config.stateDir));
      if (before.incoming[projectId]?.stage === "staged") yield* discard(projectId);

      // It lived here before and moved away: its old copy waits in Deleted —
      // it comes back as this move (the copy arriving is the newer one).
      const deleted = yield* promise("Couldn't read deleted assistants", () =>
        readDeletedAssistants(config.stateDir),
      );
      const kept = deleted.find((record) => record.projectId === projectId);
      if (kept !== undefined) {
        yield* promise("Couldn't clear its old copy", async () => {
          await fsp.rm(kept.trashPath, { recursive: true, force: true });
          await dropDeletedAssistant(config.stateDir, projectId);
        });
        for (const threadId of kept.archivedThreadIds) {
          yield* engine
            .dispatch(
              {
                type: "thread.unarchive",
                commandId: CommandId.make(`assistant-move-back:${crypto.randomUUID()}`),
                threadId: ThreadId.make(threadId),
              },
              { origin: assistantCommandOrigin({ assistantKey: projectId }) },
            )
            .pipe(Effect.ignore);
        }
      }
      const existing = yield* projectOf(projectId);
      if (!isUno && Option.isSome(existing) && kept === undefined) {
        return yield* refuse(`${bundle.title} already lives on this computer.`, 409);
      }

      let backup: IncomingMove["backup"] = null;
      if (isUno && Option.isSome(existing)) {
        const workspaceRoot = existing.value.workspaceRoot;
        const rows = yield* connectorRows(projectId);
        const workspaceBackup = yield* promise("Couldn't put this computer's Uno aside", () =>
          putAside(workspaceRoot, trashDir, "home-before-move"),
        );
        const stateBackup = yield* promise("Couldn't put this computer's Uno aside", () =>
          putAside(
            assistantStateDir(config.stateDir, projectId),
            moveBackupDir(config.stateDir),
            projectId,
          ),
        );
        backup = {
          workspaceRoot,
          workspaceBackup,
          stateBackup,
          title: existing.value.title,
          defaultModelSelection: existing.value.defaultModelSelection ?? null,
          connectorRows: rows,
        };
      }
      yield* promise("Couldn't record the move", () =>
        updateMoves(config.stateDir, (record) => ({
          ...record,
          incoming: {
            ...record.incoming,
            [projectId]: {
              projectId,
              from: input.from,
              at: new Date().toISOString(),
              stage: "staged",
              isUno,
              created: Option.isNone(existing) || kept !== undefined,
              backup,
              activated: [],
              reminderIds: [],
            },
          },
        })),
      );

      // Its settings first: its token is issued with its own preset.
      const written = yield* Effect.gen(function* () {
        yield* promise("Couldn't write its settings", async () => {
          const stateDir = assistantStateDir(config.stateDir, projectId);
          await fsp.mkdir(stateDir, { recursive: true });
          await writeFiles(stateDir, bundle.state);
        });
        yield* revokeToken(projectId);
        yield* assistants
          .ensureAssistant({ projectId: ProjectId.make(projectId), title: bundle.title })
          .pipe(Effect.mapError((error) => refuse(error.detail, 500)));
        const project = yield* projectOf(projectId);
        if (Option.isNone(project)) return yield* refuse("Its project didn't appear here.", 500);
        const count = yield* promise("Couldn't write its folder", () =>
          writeFiles(project.value.workspaceRoot, bundle.workspace),
        );
        yield* setMeta(projectId, {
          title: bundle.title,
          defaultModelSelection: bundle.defaultModelSelection,
        });
        return { count, root: project.value.workspaceRoot };
      }).pipe(
        // Nothing half-made stays: the copy is discarded before the error goes back.
        Effect.tapError(() => discard(projectId).pipe(Effect.ignore)),
      );

      // The check: it is up here — project, folder, instructions, token.
      const problems: string[] = [];
      const expected = bundle.workspace.filter(
        (file) => file.path !== ".mcp.json" && file.path !== ".uno-assistant.json",
      ).length;
      if (written.count !== expected) {
        problems.push(`${expected - written.count} of its files didn't get written`);
      }
      if (!(yield* Effect.promise(() => pathExists(nodePath.join(written.root, "AGENTS.md"))))) {
        problems.push("its instructions (AGENTS.md) are missing");
      }
      const token = yield* tokens
        .getActiveByLabel(assistantTokenLabel(ProjectId.make(projectId)))
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(token)) problems.push("it has no key to its tools here");
      const result: AssistantMoveImportResult = {
        projectId,
        ok: problems.length === 0,
        problems,
      };
      yield* Effect.logInfo("assistant move staged here").pipe(
        Effect.annotateLogs({ projectId, from: input.from.name, files: written.count, problems }),
      );
      return result;
    });

  const activate = (input: {
    readonly projectId: string;
    readonly bundle: AssistantMoveBundle;
    readonly from: AssistantMoveComputer;
  }) =>
    Effect.gen(function* () {
      const { projectId, bundle } = input;
      const moves = yield* promise("Couldn't read the moves", () => readMoves(config.stateDir));
      const record = moves.incoming[projectId];
      if (record === undefined || record.stage !== "staged") {
        return yield* refuse("Nothing is waiting to move in here.", 409);
      }
      const relink: Array<"telegram" | "slack"> = [];
      const activated: Array<"telegram" | "slack"> = [];
      const current = yield* connectorRows(projectId);
      for (const connector of bundle.connectors) {
        if (connector.via === "relay") {
          // Uno's bot is per computer: kept when this computer has its own link.
          if (!current.some((row) => row.kind === connector.kind)) relink.push(connector.kind);
          continue;
        }
        if (connectorVia(connector.kind, connector.config) === null) {
          return yield* refuse(`Its ${connector.kind} settings didn't read here.`, 400);
        }
        // Recorded before the write, so a discard turns it off again.
        yield* promise("Couldn't record the move", () =>
          updateMoves(config.stateDir, (now) => {
            const entry = now.incoming[projectId];
            return entry === undefined
              ? now
              : {
                  ...now,
                  incoming: {
                    ...now.incoming,
                    [projectId]: { ...entry, activated: [...entry.activated, connector.kind] },
                  },
                };
          }),
        );
        yield* putConnectorRow(projectId, { kind: connector.kind, config: connector.config });
        activated.push(connector.kind);
      }
      const reminderIds = yield* insertReminders(projectId, bundle.reminders);
      yield* promise("Couldn't record the move", () =>
        updateMoves(config.stateDir, (now) => {
          const entry = now.incoming[projectId];
          const { [projectId]: _cameBack, ...outgoing } = now.outgoing;
          return entry === undefined
            ? now
            : {
                outgoing,
                incoming: {
                  ...now.incoming,
                  [projectId]: {
                    ...entry,
                    stage: "active",
                    at: new Date().toISOString(),
                    reminderIds,
                  },
                },
              };
        }),
      );
      yield* Effect.logInfo("assistant moved in").pipe(
        Effect.annotateLogs({ projectId, from: input.from.name, activated, relink }),
      );
      const result: AssistantMoveActivateResult = { relink };
      return result;
    });

  return { exportBundle, release, unrelease, importBundle, activate, discard };
});

export type AssistantMoveOps = Effect.Success<typeof makeAssistantMoveOps>;
