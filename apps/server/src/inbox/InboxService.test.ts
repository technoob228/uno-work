import type { OrchestrationEvent } from "@t3tools/contracts";
import { Effect, Layer, Option, PubSub, Stream } from "effect";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeInboxService } from "./InboxService.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "inbox-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const event = (type: string, payload: unknown): OrchestrationEvent =>
  ({ type, payload, metadata: {} }) as unknown as OrchestrationEvent;

const run = <A>(
  body: (
    service: Effect.Success<ReturnType<typeof makeInboxService>>,
    publish: (event: OrchestrationEvent) => Promise<void>,
  ) => Promise<A>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const service = yield* makeInboxService().pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig, { stateDir: root } as ServerConfigShape),
              Layer.mock(OrchestrationEngineService)({
                streamDomainEvents: Stream.fromPubSub(events),
              }),
              Layer.mock(ProjectionSnapshotQuery)({
                getThreadShellById: () =>
                  Effect.succeed(
                    Option.some({
                      title: "Landing page for the bakery",
                      archivedAt: null,
                    } as never),
                  ),
                getThreadDetailById: () =>
                  Effect.succeed(
                    Option.some({
                      messages: [{ role: "assistant", text: "**Done** — button added.\nMore." }],
                    } as never),
                  ),
              }),
            ),
          ),
        );
        // Let the forked event listener subscribe before anything is published.
        yield* Effect.sleep("20 millis");
        const publish = (next: OrchestrationEvent) =>
          Effect.runPromise(PubSub.publish(events, next)).then(
            () => new Promise<void>((resolve) => setTimeout(resolve, 30)),
          );
        return yield* Effect.promise(() => body(service, publish));
      }),
    ),
  );

describe("InboxService", () => {
  it("turns a finished turn into an item, and keeps it across a restart", async () => {
    await run(async (service, publish) => {
      await publish(
        event("thread.session-set", {
          threadId: "t1",
          session: { status: "running", activeTurnId: "x", lastError: null },
        }),
      );
      await publish(
        event("thread.session-set", {
          threadId: "t1",
          session: { status: "ready", activeTurnId: null, lastError: null },
        }),
      );
      const snapshot = await Effect.runPromise(service.snapshot);
      expect(snapshot.unread).toBe(1);
      expect(snapshot.items[0]).toMatchObject({
        kind: "agent.done",
        title: "Landing page for the bakery",
        body: "Finished — Done — button added.",
        open: { kind: "thread", threadId: "t1" },
      });
      await Effect.runPromise(
        service.post({
          kind: "app",
          source: { kind: "app", id: "office", name: "Office", icon: null },
          title: "Boris commented on report.docx",
        }),
      );
    });
    // The scope closed = the daemon stopped; the file is private and complete.
    const file = path.join(root, "inbox.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8")).items).toHaveLength(2);

    await run(async (service, publish) => {
      expect((await Effect.runPromise(service.snapshot)).items).toHaveLength(2);
      // Writing to the chat again reads its "finished" item.
      await publish(event("thread.turn-start-requested", { threadId: "t1" }));
      const snapshot = await Effect.runPromise(service.snapshot);
      expect(snapshot.unread).toBe(1);
      await Effect.runPromise(service.update({ action: "readAll" }));
      expect((await Effect.runPromise(service.snapshot)).unread).toBe(0);
    });
  });
});
