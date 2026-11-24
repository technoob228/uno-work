/**
 * Allow / Decline presses in Slack (slackButtons.ts, 23.11) — the Slack
 * connector's live half: the groups of sent approval messages (kept in
 * `slack-buttons.json`, so an update doesn't turn every button into
 * "expired"), a press (`block_actions`, from the relay queue or Socket Mode)
 * decided like a Telegram `callback_query`, and retiring the buttons of an
 * approval answered elsewhere.
 *
 * @module manager/Layers/slackPresses
 */
import {
  ApprovalRequestId,
  CommandId,
  type ManagerSlackConnectorConfig,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { WebClient } from "@slack/web-api";
import { Effect, Option, Ref, Semaphore } from "effect";
import * as crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

import { BrowserBridge } from "../../browserBridge.ts";
import { slackCommandOrigin } from "../../orchestration/commandOrigin.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import {
  answeredElsewhereLine,
  type ButtonGroup,
  type ConnectorButtonsState,
  decodeButtonsState,
  EMPTY_BUTTONS_STATE,
  groupsForRequest,
  pressedLine,
  pressToastText,
  pruneButtonsState,
  removeButtonGroup,
  requestGoneLine,
} from "../connectorButtons.ts";
import type { ReplyLanguage } from "../connectorReplyText.ts";
import { classifySlackSender, type ConnectorSenderRole } from "../connectorSenders.ts";
import { decideSlackPress, parseSlackPress, slackFinishedBlocks } from "../slackButtons.ts";

export interface SlackPressesDeps {
  readonly stateDir: string;
  readonly orchestrationEngine: OrchestrationEngineShape;
  /** The assistants routed through this connection (their channels and owners count). */
  readonly routedSlackRowsOf: (
    holder: ProjectId,
  ) => Effect.Effect<ReadonlyArray<{ readonly config: ManagerSlackConnectorConfig }>>;
  /** The live Web API client of a connection, or null. */
  readonly webOf: (projectId: ProjectId) => WebClient | null;
  /** Our markdown as Slack mrkdwn. */
  readonly slackText: (text: string) => string;
}

export const makeSlackPresses = (deps: SlackPressesDeps) =>
  Effect.gen(function* () {
    const buttonsFile = nodePath.join(deps.stateDir, "slack-buttons.json");
    const buttonsRef = yield* Ref.make<ConnectorButtonsState>(
      yield* Effect.promise(() =>
        fsPromises
          .readFile(buttonsFile, "utf8")
          .then((raw) => pruneButtonsState(decodeButtonsState(JSON.parse(raw)), Date.now()))
          .catch(() => EMPTY_BUTTONS_STATE),
      ),
    );
    const buttonsWriteLock = yield* Semaphore.make(1);
    const updateButtons = (change: (state: ConnectorButtonsState) => ConnectorButtonsState) =>
      buttonsWriteLock.withPermits(1)(
        Effect.gen(function* () {
          const next = yield* Ref.updateAndGet(buttonsRef, change);
          yield* Effect.promise(async () => {
            const temp = `${buttonsFile}.${process.pid}.tmp`;
            await fsPromises.mkdir(nodePath.dirname(buttonsFile), { recursive: true });
            await fsPromises.writeFile(temp, JSON.stringify(next), { mode: 0o600 });
            await fsPromises.rename(temp, buttonsFile);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("slack buttons not saved").pipe(Effect.annotateLogs({ cause })),
            ),
          );
          return next;
        }),
      );
    const pendingApprovals = Option.getOrNull(
      yield* Effect.serviceOption(ProjectionPendingApprovalRepository),
    );
    const browserBridge = Option.getOrNull(yield* Effect.serviceOption(BrowserBridge));

    /** A group's message once answered: its text and `line`, no buttons. */
    const finishSlackMessage = (web: WebClient, group: ButtonGroup, line: string) => {
      const ts = group.slackTs;
      if (ts === undefined) return Effect.void;
      const text = deps.slackText(group.text ?? "");
      return Effect.tryPromise(() =>
        web.chat.update({
          channel: group.chatId,
          ts,
          text: `${text}\n\n${line}`.trim(),
          blocks: slackFinishedBlocks(text, line) as never,
        }),
      ).pipe(Effect.ignore);
    };

    /** A line only `user` sees in `channel` (Telegram's toast). */
    const tellOnly = (web: WebClient, channel: string, user: string, text: string) =>
      Effect.tryPromise(() => web.chat.postEphemeral({ channel, user, text })).pipe(Effect.ignore);

    /**
     * A press of one of our buttons (`block_actions`). Only the owner, in the
     * channel and on the message the buttons went with, through this app; the
     * group is spent before anything runs, so a double press does nothing twice.
     */
    const handlePress = (
      projectId: ProjectId,
      config: ManagerSlackConnectorConfig,
      web: WebClient,
      payload: unknown,
    ) =>
      Effect.gen(function* () {
        const press = parseSlackPress(payload);
        if (press === null) return;
        const routed = yield* deps.routedSlackRowsOf(projectId);
        const allowedHere =
          config.allowedChannelIds.includes(press.channel) ||
          routed.some((row) => row.config.allowedChannelIds.includes(press.channel));
        const senderRole: ConnectorSenderRole = allowedHere
          ? classifySlackSender({
              userId: press.userId,
              senderIsBot: false,
              // A 1:1 DM with the app holds only its person (channel ids "D…").
              isDirectMessage: press.channel.startsWith("D"),
              ownerUserIds: [
                ...(config.ownerUserIds ?? []),
                ...routed.flatMap((row) => row.config.ownerUserIds ?? []),
              ],
              groupMembers: config.groupMembers,
            })
          : "ignore";
        const state = yield* Ref.get(buttonsRef);
        const decided = decideSlackPress({
          state,
          press,
          connectorProjectId: projectId,
          senderIsOwner: senderRole === "owner",
          nowMs: Date.now(),
        });
        const groupId = press.actionId.split(":")[1];
        const language = state.groups.find((group) => group.id === groupId)?.language ?? "en";
        if (decided.kind !== "ok") {
          yield* tellOnly(web, press.channel, press.userId, pressToastText(decided.kind, language));
          yield* Effect.logInfo("slack button press refused").pipe(
            Effect.annotateLogs({ projectId, channel: press.channel, reason: decided.kind }),
          );
          return;
        }
        const { group, button } = decided;
        yield* updateButtons((current) => removeButtonGroup(current, group.id));
        const lang = group.language ?? language;
        const gone = Effect.gen(function* () {
          yield* tellOnly(web, press.channel, press.userId, requestGoneLine(lang));
          yield* finishSlackMessage(web, group, answeredElsewhereLine(lang));
        });
        const action = button.action;
        switch (action.kind) {
          case "approval": {
            const threadId = ThreadId.make(group.threadId);
            const open =
              pendingApprovals === null
                ? true
                : (yield* pendingApprovals
                    .listByThreadId({ threadId })
                    .pipe(Effect.orElseSucceed(() => []))).some(
                    (row) => row.status === "pending" && row.requestId === action.requestId,
                  );
            if (!open) {
              yield* gone;
              return;
            }
            yield* deps.orchestrationEngine.dispatch(
              {
                type: "thread.approval.respond",
                commandId: CommandId.make(`slack:${crypto.randomUUID()}`),
                threadId,
                requestId: ApprovalRequestId.make(action.requestId),
                decision: action.decision,
                createdAt: new Date().toISOString(),
              },
              { origin: slackCommandOrigin(press.channel) },
            );
            yield* finishSlackMessage(web, group, pressedLine(button.label));
            yield* Effect.logInfo("slack button resolved an approval").pipe(
              Effect.annotateLogs({ projectId, channel: press.channel, decision: action.decision }),
            );
            return;
          }
          case "tool-approval": {
            const answered =
              browserBridge === null
                ? false
                : yield* browserBridge.completeToolApprovalById({
                    requestId: action.requestId,
                    approved: action.approved,
                  });
            if (!answered) {
              yield* gone;
              return;
            }
            yield* finishSlackMessage(web, group, pressedLine(button.label));
            yield* Effect.logInfo("slack button answered a Uno Work approval").pipe(
              Effect.annotateLogs({ projectId, channel: press.channel, approved: action.approved }),
            );
            return;
          }
          default:
            // Only approvals are sent as Slack buttons (slackPressableRows).
            yield* finishSlackMessage(web, group, pressedLine(button.label));
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("slack button press failed").pipe(
            Effect.annotateLogs({ projectId, cause }),
          ),
        ),
      );

    const retireRequestButtons = (requestId: string, line?: (language: ReplyLanguage) => string) =>
      Effect.gen(function* () {
        const groups = groupsForRequest(yield* Ref.get(buttonsRef), requestId);
        if (groups.length === 0) return;
        yield* updateButtons((state) =>
          groups.reduce((next, group) => removeButtonGroup(next, group.id), state),
        );
        for (const group of groups) {
          const web = deps.webOf(ProjectId.make(group.connectorProjectId));
          if (web === null) continue;
          const language = group.language ?? "en";
          yield* finishSlackMessage(
            web,
            group,
            line?.(language) ?? answeredElsewhereLine(language),
          );
        }
      });

    return { buttonsRef, updateButtons, handlePress, retireRequestButtons };
  });
