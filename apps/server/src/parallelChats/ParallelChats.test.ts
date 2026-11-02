/**
 * Parallel chats against real git: a project folder synced without git
 * (`.uno-git` inside it, like uno-sync makes), chats as plain objects whose
 * folder and lines change through the same commands the engine would get.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
import { autoCopyPath, claudeProjectDirName } from "./parallelRules.ts";

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

it.layer(TestLayer)("ParallelChats", (it) => {
  describe("off", () => {
    it.effect("makes no copy and runs no git, even with the folder busy", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        world.mode = "off";
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        yield* startTurn(service, world, "aaaaaaaa-1");
        const second = yield* startTurn(service, world, "bbbbbbbb-2");
        expect(second.thread.worktreePath).toBeNull();
        expect(second.agentNote).toBeNull();
        yield* endTurn(service, world, "bbbbbbbb-2");
        yield* endTurn(service, world, "aaaaaaaa-1");
        yield* service.drainAll;
        yield* service.reconcile;
        expect(world.gitCalls).toBe(0);
        expect(existsSync(world.worktreesDir)).toBe(false);
      }),
    );

    it.effect("still joins a copy made while it was on", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        yield* startTurn(service, world, "aaaaaaaa-1");
        const second = yield* startTurn(service, world, "bbbbbbbb-2");
        const copy = second.thread.worktreePath!;
        write(nodePath.join(copy, "b.md"), "B\n");
        world.mode = "off";
        yield* endTurn(service, world, "bbbbbbbb-2");
        yield* endTurn(service, world, "aaaaaaaa-1");
        expect(read(nodePath.join(world.root, "b.md"))).toBe("B\n");
      }),
    );
  });

  describe("where a chat works", () => {
    it.effect(
      "the first chat takes the folder, the second gets a copy with .env and node_modules",
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const service = yield* makeService(world);
          addThread(world, "aaaaaaaa-1");
          addThread(world, "bbbbbbbb-2");
          const first = yield* startTurn(service, world, "aaaaaaaa-1");
          expect(first.thread.worktreePath).toBeNull();
          const second = yield* startTurn(service, world, "bbbbbbbb-2");
          const copy = second.thread.worktreePath!;
          expect(copy).toBe(
            autoCopyPath({
              worktreesDir: world.worktreesDir,
              root: world.root,
              threadId: "bbbbbbbb-2",
            }),
          );
          expect(threadOf(world, "bbbbbbbb-2").worktreePath).toBe(copy);
          expect(threadOf(world, "bbbbbbbb-2").branch).toBeNull();
          expect(second.agentNote).toContain(copy);
          expect(read(nodePath.join(copy, "plans.md"))).toBe(
            read(nodePath.join(world.root, "plans.md")),
          );
          expect(read(nodePath.join(copy, ".env"))).toBe("TOKEN=abc\n");
          const linked = nodePath.join("node_modules", "left-pad", "index.js");
          expect(statSync(nodePath.join(copy, linked)).ino).toBe(
            statSync(nodePath.join(world.root, linked)).ino,
          );
          const lock = nodePath.join("node_modules", ".package-lock.json");
          expect(statSync(nodePath.join(copy, lock)).ino).not.toBe(
            statSync(nodePath.join(world.root, lock)).ino,
          );
          expect(world.lines).toEqual([]);
        }),
    );

    it.effect("two chats one after another in a free folder both work in it", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        yield* startTurn(service, world, "aaaaaaaa-1");
        yield* endTurn(service, world, "aaaaaaaa-1");
        const second = yield* startTurn(service, world, "bbbbbbbb-2");
        expect(second.thread.worktreePath).toBeNull();
      }),
    );

    it.effect("a chat opened from a chat in a copy doesn't share that copy", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        yield* startTurn(service, world, "aaaaaaaa-1");
        const second = yield* startTurn(service, world, "bbbbbbbb-2");
        const child = addThread(world, "cccccccc-3");
        world.threads[world.threads.indexOf(child)] = {
          ...child,
          worktreePath: second.thread.worktreePath,
        };
        const third = yield* startTurn(service, world, "cccccccc-3");
        expect(third.thread.worktreePath).not.toBe(second.thread.worktreePath);
        expect(third.thread.worktreePath).toContain("uno-auto-cccccccc");
      }),
    );

    it.effect("the home folder and projects with their own git get no copies", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        world.projects[0] = { ...world.projects[0]!, workspaceRoot: world.home };
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        yield* startTurn(service, world, "aaaaaaaa-1");
        expect((yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath).toBeNull();

        const own = nodePath.join(world.home, "projects", "own");
        mkdirSync(own, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: own });
        world.projects[0] = { ...world.projects[0]!, workspaceRoot: own };
        addThread(world, "cccccccc-3");
        expect((yield* startTurn(service, world, "cccccccc-3")).thread.worktreePath).toBeNull();
        expect(existsSync(world.worktreesDir)).toBe(false);
      }),
    );

    it.effect(
      "an old chat on another agent stays in the folder; an old Claude chat moves with its transcript",
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const service = yield* makeService(world);
          addThread(world, "aaaaaaaa-1");
          addThread(world, "bbbbbbbb-2");
          addThread(world, "cccccccc-3");
          world.sessions.set("bbbbbbbb-2", { driver: "opencode", resumeId: "saved-session" });
          const sessionId = "1b4f6a3e-0000-4000-8000-000000000001";
          world.sessions.set("cccccccc-3", { driver: "claudeAgent", resumeId: sessionId });
          write(
            nodePath.join(
              world.claudeDir,
              "projects",
              claudeProjectDirName(world.root),
              `${sessionId}.jsonl`,
            ),
            '{"type":"user"}\n',
          );
          yield* startTurn(service, world, "aaaaaaaa-1");
          expect((yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath).toBeNull();
          const moved = yield* startTurn(service, world, "cccccccc-3");
          const copy = moved.thread.worktreePath!;
          expect(copy).toContain("uno-auto-cccccccc");
          expect(
            read(
              nodePath.join(
                world.claudeDir,
                "projects",
                claudeProjectDirName(copy),
                `${sessionId}.jsonl`,
              ),
            ),
          ).toBe('{"type":"user"}\n');
        }),
    );
  });

  describe("joining the folder", () => {
    it.effect("waits for the folder's chat, then joins without touching its edits", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        yield* startTurn(service, world, "aaaaaaaa-1");
        const copy = (yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath!;
        write(nodePath.join(copy, "b.md"), "B\n");
        write(nodePath.join(world.root, "a.md"), "A, half done\n");
        yield* endTurn(service, world, "bbbbbbbb-2");
        expect(existsSync(nodePath.join(world.root, "b.md"))).toBe(false);
        expect(world.lines).toEqual([
          { threadId: "bbbbbbbb-2", line: "Joins the project when the other chat finishes." },
        ]);
        write(nodePath.join(world.root, "a.md"), "A, done\n");
        yield* endTurn(service, world, "aaaaaaaa-1");
        expect(read(nodePath.join(world.root, "b.md"))).toBe("B\n");
        expect(read(nodePath.join(world.root, "a.md"))).toBe("A, done\n");
        expect(read(nodePath.join(copy, "a.md"))).toBe("A, done\n");
        expect(world.lines.at(-1)).toEqual({
          threadId: "bbbbbbbb-2",
          line: "Combined with changes from another chat.",
        });
        expect(service.pendingIds()).toEqual([]);
        // The folder's real index and history are untouched: the sync saves it as before.
        expect(hidden(world.root, ["status", "--porcelain"])).toContain("a.md");
      }),
    );

    it.effect("a copy that changed nothing joins nothing and says nothing", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        yield* startTurn(service, world, "aaaaaaaa-1");
        yield* startTurn(service, world, "bbbbbbbb-2");
        yield* endTurn(service, world, "bbbbbbbb-2");
        yield* endTurn(service, world, "aaaaaaaa-1");
        expect(world.lines).toEqual([]);
      }),
    );

    it.effect("two copies finish in a row: both join", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        addThread(world, "cccccccc-3");
        yield* startTurn(service, world, "aaaaaaaa-1");
        const b = (yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath!;
        const c = (yield* startTurn(service, world, "cccccccc-3")).thread.worktreePath!;
        write(nodePath.join(b, "b.md"), "B\n");
        write(nodePath.join(c, "c.md"), "C\n");
        yield* endTurn(service, world, "bbbbbbbb-2");
        yield* endTurn(service, world, "cccccccc-3");
        yield* endTurn(service, world, "aaaaaaaa-1");
        expect(read(nodePath.join(world.root, "b.md"))).toBe("B\n");
        expect(read(nodePath.join(world.root, "c.md"))).toBe("C\n");
      }),
    );

    it.effect("a copy alone in a free folder joins right after its turn", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        yield* startTurn(service, world, "aaaaaaaa-1");
        const copy = (yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath!;
        yield* endTurn(service, world, "aaaaaaaa-1");
        write(nodePath.join(copy, "README.md"), "# Site by B\n");
        yield* endTurn(service, world, "bbbbbbbb-2");
        expect(read(nodePath.join(world.root, "README.md"))).toBe("# Site by B\n");
        expect(world.lines).toEqual([]);
        // Its next turn stays in the copy, which caught up with the folder.
        write(nodePath.join(world.root, "later.md"), "later\n");
        const next = yield* startTurn(service, world, "bbbbbbbb-2");
        expect(next.thread.worktreePath).toBe(copy);
        expect(read(nodePath.join(copy, "later.md"))).toBe("later\n");
      }),
    );

    it.effect("after a restart the waiting copy joins", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        yield* startTurn(service, world, "aaaaaaaa-1");
        const copy = (yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath!;
        write(nodePath.join(copy, "b.md"), "B\n");
        setStatus(world, "bbbbbbbb-2", "ready");
        setStatus(world, "aaaaaaaa-1", "interrupted");
        const restarted = yield* makeService(world);
        yield* restarted.reconcile;
        yield* restarted.drainAll;
        expect(read(nodePath.join(world.root, "b.md"))).toBe("B\n");
      }),
    );
  });

  describe("an idle copy", () => {
    it.effect(
      "goes after a quiet day once all its work joined, and comes back on the next message",
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const service = yield* makeService(world);
          addThread(world, "aaaaaaaa-1");
          addThread(world, "bbbbbbbb-2");
          yield* startTurn(service, world, "aaaaaaaa-1");
          const copy = (yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath!;
          write(nodePath.join(copy, "b.md"), "B\n");
          write(nodePath.join(copy, "unjoined-later.md"), "x\n");
          yield* endTurn(service, world, "aaaaaaaa-1");
          yield* endTurn(service, world, "bbbbbbbb-2");
          expect(read(nodePath.join(world.root, "unjoined-later.md"))).toBe("x\n");
          // Not a day yet: stays.
          yield* service.sweepIdleCopies;
          expect(existsSync(copy)).toBe(true);
          world.clock += 25 * 60 * 60_000;
          yield* service.sweepIdleCopies;
          expect(existsSync(copy)).toBe(false);
          // Off meanwhile: the chat still gets its copy back at the same path.
          world.mode = "off";
          const next = yield* startTurn(service, world, "bbbbbbbb-2");
          expect(next.thread.worktreePath).toBe(copy);
          expect(read(nodePath.join(copy, "b.md"))).toBe("B\n");
        }),
    );

    it.effect("with work that never joined stays", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        yield* startTurn(service, world, "aaaaaaaa-1");
        const copy = (yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath!;
        setStatus(world, "bbbbbbbb-2", "error");
        write(nodePath.join(copy, "b.md"), "B\n");
        world.clock += 25 * 60 * 60_000;
        yield* service.sweepIdleCopies;
        expect(existsSync(copy)).toBe(true);
      }),
    );
  });

  describe("a deleted chat", () => {
    it.effect("its copy goes; what never joined is saved first", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        yield* startTurn(service, world, "aaaaaaaa-1");
        const copy = (yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath!;
        write(nodePath.join(copy, "draft.md"), "draft\n");
        world.threads = world.threads.filter((thread) => thread.id !== "bbbbbbbb-2");
        yield* service.onEvent({
          type: "thread.deleted",
          payload: { threadId: ThreadId.make("bbbbbbbb-2"), deletedAt: "2026-11-02T04:00:00.000Z" },
        } as unknown as OrchestrationEvent);
        expect(existsSync(copy)).toBe(false);
        expect(hidden(world.root, ["show", "refs/uno/saved/bbbbbbbb-2:draft.md"])).toBe("draft");
        expect(hidden(world.root, ["worktree", "list"])).not.toContain("uno-auto");
      }),
    );
  });

  describe("same places in both chats", () => {
    const conflictOnPrice = (world: World, service: Service) =>
      Effect.gen(function* () {
        addThread(world, "aaaaaaaa-1", "Set the price to 10");
        addThread(world, "bbbbbbbb-2", "Set the price to 20");
        yield* startTurn(service, world, "aaaaaaaa-1");
        const copy = (yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath!;
        write(nodePath.join(world.root, "config.json"), '{\n  "price": 10\n}\n');
        write(nodePath.join(copy, "config.json"), '{\n  "price": 20\n}\n');
        yield* endTurn(service, world, "aaaaaaaa-1");
        yield* endTurn(service, world, "bbbbbbbb-2");
        return copy;
      });

    it.effect("the chat gets one turn to combine; once the markers are gone its work joins", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        const copy = yield* conflictOnPrice(world, service);
        expect(world.turns).toHaveLength(1);
        expect(world.turns[0]!.text).toContain("Files to fix: config.json");
        expect(world.turns[0]!.text).toContain('"Set the price to 10"');
        expect(read(nodePath.join(copy, "config.json"))).toContain("<<<<<<<");
        expect(read(nodePath.join(world.root, "config.json"))).toBe('{\n  "price": 10\n}\n');
        // The combine turn runs and fixes it.
        world.clock += 5000;
        yield* startTurn(service, world, "bbbbbbbb-2");
        write(nodePath.join(copy, "config.json"), '{\n  "price": 20,\n  "was": 10\n}\n');
        yield* endTurn(service, world, "bbbbbbbb-2");
        expect(read(nodePath.join(world.root, "config.json"))).toBe(
          '{\n  "price": 20,\n  "was": 10\n}\n',
        );
        expect(world.turns).toHaveLength(1);
      }),
    );

    it.effect("markers left: the work waits in the copy until the person answers", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        const copy = yield* conflictOnPrice(world, service);
        world.clock += 5000;
        yield* startTurn(service, world, "bbbbbbbb-2");
        yield* endTurn(service, world, "bbbbbbbb-2");
        expect(world.lines.at(-1)?.line).toBe(
          "Your work is safe here. It joins the project after you answer.",
        );
        expect(read(nodePath.join(world.root, "config.json"))).toBe('{\n  "price": 10\n}\n');
        expect(read(nodePath.join(copy, "config.json"))).toContain("<<<<<<<");
        // Restart while waiting: still waiting, no second combine turn.
        const restarted = yield* makeService(world);
        yield* restarted.reconcile;
        yield* restarted.drainAll;
        expect(read(nodePath.join(world.root, "config.json"))).toBe('{\n  "price": 10\n}\n');
        // The person answers "20".
        world.clock += 5000;
        world.turns.push({ threadId: "bbbbbbbb-2", text: "20" });
        world.threads[world.threads.findIndex((t) => t.id === "bbbbbbbb-2")] = {
          ...threadOf(world, "bbbbbbbb-2"),
          latestTurn: {
            requestedAt: new Date(world.clock).toISOString(),
          } as OrchestrationThreadShell["latestTurn"],
        };
        yield* startTurn(restarted, world, "bbbbbbbb-2");
        write(nodePath.join(copy, "config.json"), '{\n  "price": 20\n}\n');
        setStatus(world, "bbbbbbbb-2", "ready");
        yield* restarted.onEvent(sessionSet("bbbbbbbb-2", "ready"));
        expect(read(nodePath.join(world.root, "config.json"))).toBe('{\n  "price": 20\n}\n');
        expect(world.turns.filter((turn) => turn.text.startsWith("(Uno Work)"))).toHaveLength(1);
      }),
    );

    it.effect("a binary file changed in both chats: both versions are kept", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2", "New logo");
        yield* startTurn(service, world, "aaaaaaaa-1");
        const copy = (yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath!;
        write(nodePath.join(world.root, "logo.bin"), "\u0000\u0002root");
        write(nodePath.join(copy, "logo.bin"), "\u0000\u0003copy");
        write(nodePath.join(copy, "other.md"), "other\n");
        yield* endTurn(service, world, "aaaaaaaa-1");
        yield* endTurn(service, world, "bbbbbbbb-2");
        expect(read(nodePath.join(world.root, "logo.bin"))).toBe("\u0000\u0002root");
        expect(read(nodePath.join(world.root, "logo (from New logo).bin"))).toBe(
          "\u0000\u0003copy",
        );
        expect(read(nodePath.join(world.root, "other.md"))).toBe("other\n");
        expect(world.lines.map((line) => line.line)).toContain(
          "logo.bin changed in two chats. Both versions are kept. Tell this chat which one to use.",
        );
      }),
    );

    it.effect("Cyrillic file names with spaces combine too", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const service = yield* makeService(world);
        addThread(world, "aaaaaaaa-1");
        addThread(world, "bbbbbbbb-2");
        write(
          nodePath.join(world.root, "заметки и планы.md"),
          "раз\nдва\nтри\nчетыре\nпять\nшесть\n",
        );
        yield* startTurn(service, world, "aaaaaaaa-1");
        const copy = (yield* startTurn(service, world, "bbbbbbbb-2")).thread.worktreePath!;
        write(
          nodePath.join(world.root, "заметки и планы.md"),
          "РАЗ\nдва\nтри\nчетыре\nпять\nшесть\n",
        );
        write(nodePath.join(copy, "заметки и планы.md"), "раз\nдва\nтри\nчетыре\nпять\nШЕСТЬ\n");
        yield* endTurn(service, world, "aaaaaaaa-1");
        yield* endTurn(service, world, "bbbbbbbb-2");
        expect(read(nodePath.join(world.root, "заметки и планы.md"))).toBe(
          "РАЗ\nдва\nтри\nчетыре\nпять\nШЕСТЬ\n",
        );
      }),
    );
  });
});
