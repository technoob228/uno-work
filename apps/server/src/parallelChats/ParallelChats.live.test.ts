/**
 * Parallel chats with a real agent combining the conflict: the service on
 * real git, `claude -p` (Haiku) runs the combine turn in the copy with the
 * exact text the chat would get. Manual: needs a signed-in `claude` and spends
 * a few cents. Run with `UNO_PARALLEL_LIVE=1 bun run test src/parallelChats/ParallelChats.live.test.ts`;
 * what the agent said goes to `UNO_PARALLEL_LIVE_LOG` (default /tmp/uno-parallel-live.log).
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ParallelChatsMode,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { PARALLEL_CHATS_ACTIVITY_KIND } from "@t3tools/shared/parallelChats";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeParallelChats } from "./ParallelChats.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-parallel-chats-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const PROJECT = ProjectId.make("project-1");

const write = (file: string, text: string) => {
  mkdirSync(nodePath.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const read = (file: string) => readFileSync(file, "utf8");

const hidden = (root: string, args: ReadonlyArray<string>) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_DIR: nodePath.join(root, ".uno-git"),
      GIT_WORK_TREE: root,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@x",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

interface Line {
  readonly threadId: string;
  readonly line: string;
}

interface World {
  readonly dir: string;
  readonly root: string;
  readonly home: string;
  readonly worktreesDir: string;
  readonly claudeDir: string;
  mode: ParallelChatsMode;
  projects: OrchestrationProjectShell[];
  threads: OrchestrationThreadShell[];
  lines: Line[];
  turns: { readonly threadId: string; readonly text: string }[];
  sessions: Map<string, { driver: string | null; resumeId: string | null }>;
  gitCalls: number;
  clock: number;
}

/** A synced project without git, the way uno-sync sets it up. */
const makeWorld = Effect.acquireRelease(
  Effect.sync((): World => {
    const dir = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "uno-parallel-")));
    const home = nodePath.join(dir, "home");
    const root = nodePath.join(home, "projects", "site");
    mkdirSync(root, { recursive: true });
    const gitDir = nodePath.join(root, ".uno-git");
    execFileSync("git", ["init", "-q", "--bare", gitDir]);
    execFileSync("git", ["--git-dir", gitDir, "config", "core.bare", "false"]);
    execFileSync("git", ["--git-dir", gitDir, "symbolic-ref", "HEAD", "refs/heads/main"]);
    write(
      nodePath.join(gitDir, "info", "exclude"),
      [".env", ".env.*", "node_modules/", ".git/", ".uno-git/", ".uno-git.*", ""].join("\n"),
    );
    write(nodePath.join(root, "README.md"), "# Site\n");
    write(nodePath.join(root, "plans.md"), "# Plans\n\n- one\n\n## Later\n\n- later\n");
    write(nodePath.join(root, "config.json"), '{\n  "price": 5\n}\n');
    write(nodePath.join(root, "logo.bin"), "\u0000\u0001logo");
    write(nodePath.join(root, ".env"), "TOKEN=abc\n");
    write(nodePath.join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    write(nodePath.join(root, "node_modules", ".package-lock.json"), '{"lock":1}\n');
    hidden(root, ["add", "-A"]);
    hidden(root, ["commit", "-q", "-m", "Saved on this computer"]);
    return {
      dir,
      root,
      home,
      worktreesDir: nodePath.join(dir, "worktrees"),
      claudeDir: nodePath.join(home, ".claude"),
      mode: "nogit",
      projects: [
        {
          id: PROJECT,
          title: "site",
          workspaceRoot: root,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-11-02T00:00:00.000Z",
          updatedAt: "2026-11-02T00:00:00.000Z",
        } as unknown as OrchestrationProjectShell,
      ],
      threads: [],
      lines: [],
      turns: [],
      sessions: new Map(),
      gitCalls: 0,
      clock: Date.parse("2026-11-02T03:00:00.000Z"),
    };
  }),
  (world) => Effect.sync(() => rmSync(world.dir, { recursive: true, force: true })),
);

const addThread = (world: World, id: string, title = `Chat ${id}`) => {
  const thread = {
    id: ThreadId.make(id),
    projectId: PROJECT,
    title,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    session: null,
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
  } as unknown as OrchestrationThreadShell;
  world.threads.push(thread);
  return thread;
};

const threadOf = (world: World, id: string) => world.threads.find((thread) => thread.id === id)!;

const setStatus = (world: World, id: string, status: string) => {
  const index = world.threads.findIndex((thread) => thread.id === id);
  world.threads[index] = {
    ...world.threads[index]!,
    session: { status, threadId: ThreadId.make(id) } as OrchestrationThreadShell["session"],
  };
};

const sessionSet = (id: string, status: string): OrchestrationEvent =>
  ({
    type: "thread.session-set",
    payload: { threadId: ThreadId.make(id), session: { status, threadId: ThreadId.make(id) } },
  }) as unknown as OrchestrationEvent;

const makeService = (world: World) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* makeParallelChats({
      worktreesDir: world.worktreesDir,
      tempDir: nodePath.join(world.dir, "tmp"),
      home: world.home,
      git: (input) => {
        world.gitCalls++;
        return driver.execute(input);
      },
      mode: Effect.sync(() => world.mode),
      getProject: (projectId) =>
        Effect.sync(() => world.projects.find((project) => project.id === projectId) ?? null),
      getThread: (threadId) =>
        Effect.sync(() => world.threads.find((thread) => thread.id === threadId) ?? null),
      listThreads: Effect.sync(() => [...world.threads]),
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          if (command.type === "thread.meta.update") {
            const index = world.threads.findIndex((thread) => thread.id === command.threadId);
            world.threads[index] = {
              ...world.threads[index]!,
              ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
              ...(command.branch !== undefined ? { branch: command.branch } : {}),
            };
          } else if (command.type === "thread.activity.append") {
            if (command.activity.kind === PARALLEL_CHATS_ACTIVITY_KIND) {
              world.lines.push({ threadId: command.threadId, line: command.activity.summary });
            }
          } else if (command.type === "thread.turn.start") {
            world.turns.push({ threadId: command.threadId, text: command.message.text });
            const index = world.threads.findIndex((thread) => thread.id === command.threadId);
            world.threads[index] = {
              ...world.threads[index]!,
              latestTurn: {
                requestedAt: new Date(world.clock + 1000).toISOString(),
              } as OrchestrationThreadShell["latestTurn"],
            };
          }
        }),
      sessionOf: (threadId) => Effect.sync(() => world.sessions.get(threadId) ?? null),
      claudeConfigDirs: Effect.sync(() => [world.claudeDir]),
      lowDisk: Effect.succeed(false),
      now: () => world.clock,
    });
  });

type Service = Effect.Success<ReturnType<typeof makeService>>;

/** A turn of `id` starts (through the reactor's check); returns the thread it runs as. */
const startTurn = (service: Service, world: World, id: string) =>
  Effect.gen(function* () {
    const result = yield* service.beforeTurn(threadOf(world, id));
    setStatus(world, id, "running");
    yield* service.onEvent(sessionSet(id, "running"));
    return result;
  });

/** A turn of `id` ends: the session says ready, the service reacts. */
const endTurn = (service: Service, world: World, id: string) =>
  Effect.gen(function* () {
    setStatus(world, id, "ready");
    yield* service.onEvent(sessionSet(id, "ready"));
  });

const LIVE = process.env.UNO_PARALLEL_LIVE === "1";
const liveLog = (...parts: unknown[]) =>
  appendFileSync(
    process.env.UNO_PARALLEL_LIVE_LOG ?? nodePath.join(tmpdir(), "uno-parallel-live.log"),
    `${parts.map(String).join(" ")}\n`,
  );

const claude = (cwd: string, prompt: string, cont = false) =>
  execFileSync(
    "claude",
    [
      "-p",
      "--model",
      "haiku",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read Edit Write",
      ...(cont ? ["--continue"] : []),
    ],
    {
      cwd,
      input: prompt,
      encoding: "utf8",
      timeout: 180_000,
      // A test run, not a session: the Pult session hook stays quiet.
      env: { ...process.env, UNO_TRACKER_DRY: "1" },
    },
  ).trim();

describe.skipIf(!LIVE)("live", () => {
  it.layer(TestLayer)("ParallelChats live (real claude)", (it) => {
    it.effect(
      "same place, compatible: the agent combines both items",
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const service = yield* makeService(world);
          addThread(world, "aaaaaaaa-1", "Add a plan about the blog");
          addThread(world, "bbbbbbbb-2", "Add a plan about the newsletter");
          yield* startTurn(service, world, "aaaaaaaa-1");
          const copy = (yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath!;
          write(
            nodePath.join(world.root, "plans.md"),
            "# Plans\n\n- one\n- start a blog\n\n## Later\n\n- later\n",
          );
          write(
            nodePath.join(copy, "plans.md"),
            "# Plans\n\n- one\n- send a newsletter\n\n## Later\n\n- later\n",
          );
          yield* endTurn(service, world, "aaaaaaaa-1");
          yield* endTurn(service, world, "bbbbbbbb-2");
          expect(world.turns).toHaveLength(1);
          world.clock += 5000;
          yield* startTurn(service, world, "bbbbbbbb-2");
          const answer = claude(copy, world.turns[0]!.text);
          liveLog("AGENT (plans):", answer);
          yield* endTurn(service, world, "bbbbbbbb-2");
          const plans = read(nodePath.join(world.root, "plans.md"));
          liveLog("ROOT plans.md:\n" + plans);
          expect(plans).toContain("blog");
          expect(plans).toContain("newsletter");
          expect(plans).not.toContain("<<<<<<<");
        }),
      240_000,
    );

    it.effect(
      "can't both be true: the agent asks, the work waits, the answer joins",
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const service = yield* makeService(world);
          addThread(world, "aaaaaaaa-1", "Set the price to 10");
          addThread(world, "bbbbbbbb-2", "Set the price to 20");
          yield* startTurn(service, world, "aaaaaaaa-1");
          const copy = (yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath!;
          write(nodePath.join(world.root, "config.json"), '{\n  "price": 10\n}\n');
          write(nodePath.join(copy, "config.json"), '{\n  "price": 20\n}\n');
          yield* endTurn(service, world, "aaaaaaaa-1");
          yield* endTurn(service, world, "bbbbbbbb-2");
          world.clock += 5000;
          yield* startTurn(service, world, "bbbbbbbb-2");
          const question = claude(copy, world.turns[0]!.text);
          liveLog("AGENT (price):", question);
          yield* endTurn(service, world, "bbbbbbbb-2");
          liveLog("LINES:", JSON.stringify(world.lines));
          liveLog("ROOT config.json:", read(nodePath.join(world.root, "config.json")));
          liveLog("COPY config.json:", read(nodePath.join(copy, "config.json")));
          if (read(nodePath.join(copy, "config.json")).includes("<<<<<<<")) {
            expect(read(nodePath.join(world.root, "config.json"))).toBe('{\n  "price": 10\n}\n');
            world.clock += 5000;
            world.threads[world.threads.findIndex((t) => t.id === "bbbbbbbb-2")] = {
              ...threadOf(world, "bbbbbbbb-2"),
              latestTurn: {
                requestedAt: new Date(world.clock).toISOString(),
              } as OrchestrationThreadShell["latestTurn"],
            };
            yield* startTurn(service, world, "bbbbbbbb-2");
            liveLog("AGENT (answer):", claude(copy, "20", true));
            yield* endTurn(service, world, "bbbbbbbb-2");
          }
          const root = read(nodePath.join(world.root, "config.json"));
          liveLog("ROOT config.json after:", root);
          expect(root).toContain("20");
          expect(root).not.toContain("<<<<<<<");
        }),
      360_000,
    );
  });
});
