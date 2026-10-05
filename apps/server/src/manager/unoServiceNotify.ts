/**
 * Uno's service notifications ("a site is ready", "an agent needs you in the
 * browser", "Uno needs a token") reach the person through Uno's own bot —
 * @get_uno_bot, the one with payments, the course and support — never through
 * the assistant's bot (decision 05.10: the assistant lives in a bot of the
 * person's own from @BotFather, and its conversation must stay theirs).
 *
 * The console sends it: `POST /api/v1/boxes/<boxId>/work/notify-owner`
 * (fishcode `work_notify_owner.go`) with the machine token, to the Telegram
 * the Uno account is linked to. No cloud computer (a laptop), an older
 * console (404) or no linked Telegram: not delivered — the Inbox item the
 * caller already posted is all there is.
 *
 * @module manager/unoServiceNotify
 */
import { Effect } from "effect";

import {
  callWorkConsole,
  consoleBoolean,
  type FetchLike,
  type WorkMachineIdentity,
} from "./workConsole.ts";

/** The pseudo chat id a service notification reports in `ChannelNotifyResult`. */
export const UNO_SERVICE_CHAT_ID = "uno-bot";

export const sendUnoServiceNotification = (input: {
  readonly identity: WorkMachineIdentity | null;
  readonly text: string;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<{ readonly delivered: boolean }> =>
  Effect.gen(function* () {
    if (input.identity === null) return { delivered: false };
    const answer = yield* callWorkConsole({
      identity: input.identity,
      method: "POST",
      subpath: "notify-owner",
      body: { text: input.text },
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    }).pipe(
      Effect.catchTag("WorkConsoleUnreachable", (error) =>
        Effect.logWarning("uno service notification: console unreachable").pipe(
          Effect.annotateLogs({ error: error.message }),
          Effect.as(null),
        ),
      ),
    );
    if (answer === null) return { delivered: false };
    const delivered =
      answer.status >= 200 && answer.status < 300 && consoleBoolean(answer.body, "sent") === true;
    if (!delivered && answer.status !== 200) {
      yield* Effect.logInfo("uno service notification not delivered").pipe(
        Effect.annotateLogs({ status: answer.status }),
      );
    }
    return { delivered };
  });
