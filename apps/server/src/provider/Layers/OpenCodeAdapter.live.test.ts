/**
 * Live check of the shared OpenCode server against a real `uno-code` /
 * `opencode` binary — no LLM calls. Skipped unless `UNO_CODE_LIVE_BIN` points
 * at the binary:
 *
 *   UNO_CODE_LIVE_BIN=~/.unowork/uno-code/bin/uno-code \
 *     bun run --cwd apps/server vitest run src/provider/Layers/OpenCodeAdapter.live.test.ts
 *
 * For each mode (a server per thread vs. one shared server) it opens
 * `UNO_CODE_LIVE_THREADS` (default 4) threads in different folders, reports
 * the harness processes and their RSS, runs a shell command in every thread
 * to check that each one sees its own bridge token, and checks that a stopped
 * thread resumes the same OpenCode session. OpenCode's data goes to a temp
 * dir (XDG_*), never to the person's own storage.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { OpenCodeSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import { makeOpenCodeAdapter, readOpenCodeResumeCursor } from "./OpenCodeAdapter.ts";

const binary = process.env.UNO_CODE_LIVE_BIN?.replace(/^~(?=\/)/, os.homedir());
const threadCount = Number(process.env.UNO_CODE_LIVE_THREADS ?? "4");

class LiveAdapter extends Context.Service<LiveAdapter, OpenCodeAdapterShape>()(
  "test/OpenCodeLiveAdapter",
) {}

interface HarnessProcess {
  readonly pid: number;
  readonly rssKb: number;
  readonly command: string;
}

/** Descendants of this test process running the harness binary. */
function harnessProcesses(binaryPath: string): HarnessProcess[] {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      command: match[4] ?? "",
    }));
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const mine = new Set<number>();
  const queue = [process.pid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of children.get(pid) ?? []) {
      if (!mine.has(child)) {
        mine.add(child);
        queue.push(child);
      }
    }
  }
  return rows
    .filter((row) => mine.has(row.pid) && row.command.includes(path.basename(binaryPath)))
    .map(({ pid, rssKb, command }) => ({ pid, rssKb, command }));
}

const serverUrlOf = (command: string) => {
  const port = command.match(/--port=(\d+)/)?.[1];
  return port ? `http://127.0.0.1:${port}` : undefined;
};

const layerFor = (shareServer: boolean, root: string, binaryPath: string) =>
  Layer.effect(
    LiveAdapter,
    makeOpenCodeAdapter(Schema.decodeSync(OpenCodeSettings)({ binaryPath }), {
      environment: {
        ...process.env,
        XDG_DATA_HOME: path.join(root, "xdg", "data"),
        XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
        XDG_STATE_HOME: path.join(root, "xdg", "state"),
        XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({}),
      },
      bridgeEnvironment: ({ threadId }) => ({ UNO_LIVE_TOKEN: `token-${threadId}` }),
      eventSource: "global",
      shareServer,
      sharedServerLingerMs: 0,
    }),
  ).pipe(
    Layer.provideMerge(OpenCodeRuntimeLive),
    Layer.provideMerge(ServerConfig.layerTest(root, path.join(root, "state"))),
    Layer.provideMerge(ServerSettingsService.layerTest({})),
    Layer.provideMerge(
      Layer.succeed(ProviderSessionDirectory, {
        upsert: () => Effect.void,
        getProvider: () => Effect.die(new Error("unused")),
        getBinding: () => Effect.succeed(Option.none()),
        listThreadIds: () => Effect.succeed([]),
        listBindings: () => Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const runMode = (shareServer: boolean, binaryPath: string) =>
  Effect.gen(function* () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "uno-live-"));
    const adapter = yield* LiveAdapter;
    const threads = Array.from({ length: threadCount }, (_, i) => `live-thread-${i + 1}`);
    const cursors: unknown[] = [];
    for (const threadId of threads) {
      const cwd = path.join(root, "projects", threadId);
      fs.mkdirSync(cwd, { recursive: true });
      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: ThreadId.make(threadId),
        cwd,
        runtimeMode: "full-access",
      });
      cursors.push(session.resumeCursor);
    }
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 3_000)));
    const processes = harnessProcesses(binaryPath);
    const totalMb = processes.reduce((sum, p) => sum + p.rssKb, 0) / 1024;

    // Every thread's shell sees its own token (plugin in shared mode, the
    // process env per thread otherwise).
    for (const [index, threadId] of threads.entries()) {
      const cursor = readOpenCodeResumeCursor(cursors[index]);
      assert.ok(cursor);
      // Per-thread servers share OpenCode's storage, so any of them finds any
      // session: ask the thread's own server (they start in thread order).
      const urls = (
        shareServer
          ? processes
          : [processes.toSorted((a, b) => a.pid - b.pid)[index]].filter((p) => p !== undefined)
      )
        .map((p) => serverUrlOf(p.command))
        .filter(Boolean) as string[];
      let seen: string | undefined;
      for (const url of urls) {
        const client = createOpencodeClient({ baseUrl: url, directory: cursor.directory });
        const found = yield* Effect.promise(() =>
          client.session.get({ sessionID: cursor.openCodeSessionId }),
        );
        if (!found.data) continue;
        yield* Effect.promise(() =>
          client.session.shell({
            sessionID: cursor.openCodeSessionId,
            agent: "build",
            command: 'printf %s "$UNO_LIVE_TOKEN" > token.txt',
          }),
        );
        seen = fs.readFileSync(path.join(cursor.directory, "token.txt"), "utf8");
        break;
      }
      assert.equal(seen, `token-${threadId}`, `thread ${threadId} sees its own token`);
    }

    // Stop one thread and bring it back: same OpenCode session.
    const first = threads[0] as string;
    yield* adapter.stopSession(ThreadId.make(first));
    const resumed = yield* adapter.startSession({
      provider: ProviderDriverKind.make("opencode"),
      threadId: ThreadId.make(first),
      cwd: path.join(root, "projects", first),
      runtimeMode: "full-access",
      resumeCursor: cursors[0],
    });
    assert.deepEqual(resumed.resumeCursor, cursors[0], "resumed the same OpenCode session");

    yield* adapter.stopAll();
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1_500)));
    const leftover = harnessProcesses(binaryPath);
    const report = {
      mode: shareServer ? "shared" : "per-thread",
      threads: threadCount,
      processes: processes.length,
      rssMb: processes.map((p) => Math.round(p.rssKb / 1024)),
      totalMb: Math.round(totalMb),
      leftoverAfterStop: leftover.length,
    };
    fs.appendFileSync(
      process.env.UNO_CODE_LIVE_REPORT ?? path.join(os.tmpdir(), "uno-live-report.jsonl"),
      `${JSON.stringify(report)}\n`,
    );
    return report;
  }).pipe(
    Effect.provide(
      layerFor(shareServer, fs.mkdtempSync(path.join(os.tmpdir(), "uno-live-root-")), binaryPath),
    ),
  );

// it.live: the runtime waits 1 s between SIGTERM and SIGKILL (Effect.sleep),
// which never elapses under it.effect's TestClock.
it.live.skipIf(!binary)(
  "per-thread servers vs one shared server (real binary)",
  () =>
    Effect.gen(function* () {
      const binaryPath = binary as string;
      const perThread = yield* runMode(false, binaryPath);
      const shared = yield* runMode(true, binaryPath);
      assert.equal(perThread.processes >= threadCount, true);
      assert.equal(shared.processes, 1);
      assert.equal(shared.leftoverAfterStop, 0);
      assert.equal(perThread.leftoverAfterStop, 0);
    }),
  { timeout: 240_000 },
);
