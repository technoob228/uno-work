/**
 * Агент позвал человека в браузер машины (`requestHelp`): запись во «Входящих»
 * с переходом в чат и сообщение в привязанный мессенджер — человек может быть
 * не в приложении, а агент ждёт его до 10 минут.
 */
import { ThreadId, type OrchestrationThreadShell } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import { InboxService } from "./inbox/InboxService.ts";
import { ConnectorNotifyService } from "./manager/Services/ConnectorNotify.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";

export const announceBrowserHelp = (input: {
  readonly threadId: string;
  readonly reason: string;
}): Effect.Effect<void, never, InboxService | ConnectorNotifyService | ProjectionSnapshotQuery> =>
  Effect.gen(function* () {
    const threadId = ThreadId.make(input.threadId);
    const projections = yield* ProjectionSnapshotQuery;
    const shell = yield* projections.getThreadShellById(threadId).pipe(
      Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()),
      Effect.map(Option.getOrNull),
    );
    const chatTitle = shell?.title ?? "Agent";
    const reason = input.reason.trim();

    const inbox = yield* InboxService;
    yield* inbox.post({
      kind: "agent.input",
      source: { kind: "agent", id: threadId, name: chatTitle, icon: null },
      title: chatTitle,
      body: `Needs you in the browser: ${reason}`,
      open: { kind: "thread", threadId },
      groupKey: `browser-help:${threadId}`,
    });

    const notify = yield* ConnectorNotifyService;
    yield* notify.notify({
      text: `${chatTitle}: the agent needs you in the browser — ${reason}. Open this chat in Uno Work and take control of the browser tab.`,
      threadId,
      kind: "warning",
    });
  }).pipe(Effect.ignoreCause({ log: true }));
