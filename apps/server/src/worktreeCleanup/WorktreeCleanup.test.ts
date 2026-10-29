/**
 * The chat-copy cleanup against real git: a temp repository with linked
 * worktrees under a temp `worktrees/` folder, fake chats, sessions,
 * terminals and disk readings.
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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  TurnId,
  type StorageCleanupReport,
  type StorageCleanupSettings,
} from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe, expect } from "vitest";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { type CleanupThread, type DiskSpaceReading, DAY_MS } from "./policy.ts";
import {
  type CleanupSession,
  type CleanupTerminal,
  type DeletedCleanupThread,
  makeWorktreeCleanup,
} from "./WorktreeCleanup.ts";

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-cleanup-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const HOUR_MS = 60 * 60_000;
const GB = 1024 ** 3;
const ROOMY: DiskSpaceReading = { totalBytes: 100 * GB, freeBytes: 60 * GB };
const NEARLY_FULL: DiskSpaceReading = { totalBytes: 10 * GB, freeBytes: 1 * GB };
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const gitSync = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const gitOptional = (cwd: string, args: ReadonlyArray<string>) => {
  try {
    return gitSync(cwd, args);
  } catch {
    return null;
  }
};

const write = (filePath: string, contents: string) => {
  mkdirSync(nodePath.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
};

// Not `gitSync`: its trim would eat the first line's leading status column.
const statusLines = (cwd: string) =>
  execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .filter(Boolean)
    .sort();

interface World {
  readonly root: string;
  readonly repo: string;
  readonly worktreesDir: string;
  readonly savedDir: string;
  threads: CleanupThread[];
  deleted: DeletedCleanupThread[];
  sessions: CleanupSession[];
  terminals: CleanupTerminal[];
  disk: DiskSpaceReading | null;
  settings: StorageCleanupSettings;
  onGetThread?: (threadId: string) => void;
  beforeReadThreads?: Effect.Effect<void>;
}

const makeWorld = Effect.acquireRelease(
  Effect.sync((): World => {
    const root = realpathSync(mkdtempSync(nodePath.join(tmpdir(), "uno-worktree-cleanup-")));
    const repo = nodePath.join(root, "projects", "app");
    mkdirSync(repo, { recursive: true });
    gitSync(repo, ["init", "-q", "-b", "main"]);
    write(nodePath.join(repo, "README.md"), "# App\n");
    write(nodePath.join(repo, "notes.txt"), "keep me\n");
    write(nodePath.join(repo, ".gitignore"), "node_modules/\ndist/\n.env*\n!.env.example\n");
    write(nodePath.join(repo, ".env.example"), "TOKEN=\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "initial"]);
    return {
      root,
      repo,
      worktreesDir: nodePath.join(root, "worktrees"),
      savedDir: nodePath.join(root, "saved-worktrees"),
      threads: [],
      deleted: [],
      sessions: [],
      terminals: [],
      disk: ROOMY,
      settings: DEFAULT_SERVER_SETTINGS.storageCleanup,
    };
  }),
  (world) => Effect.sync(() => rmSync(world.root, { recursive: true, force: true })),
);

/** A chat copy like the ones Uno Work makes, with an installed node_modules. */
function addCopy(world: World, name: string, target?: string) {
  const branch = `uno/${name}`;
  const path = target ?? nodePath.join(world.worktreesDir, "app", name);
  mkdirSync(nodePath.dirname(path), { recursive: true });
  gitSync(world.repo, ["worktree", "add", "-q", "-b", branch, path, "main"]);
  write(nodePath.join(path, "node_modules", "left-pad", "index.js"), "x".repeat(64 * 1024));
  return { path, branch };
}

function chat(
  id: string,
  copy: { readonly path: string; readonly branch: string },
  overrides: Partial<CleanupThread> = {},
  idleMs = 4 * DAY_MS,
): CleanupThread {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: `Chat ${id}`,
    branch: copy.branch,
    worktreePath: copy.path,
    latestTurn: {
      turnId: TurnId.make(`turn-${id}`),
      state: "completed",
      requestedAt: ago(idleMs + 60_000),
      startedAt: ago(idleMs + 60_000),
      completedAt: ago(idleMs),
      assistantMessageId: null,
    },
    createdAt: ago(idleMs + DAY_MS),
    archivedAt: null,
    pinnedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: ago(idleMs + 60_000),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

/** Done by hand `idleMs` ago. */
const doneChat = (
  id: string,
  copy: { readonly path: string; readonly branch: string },
  idleMs = 4 * DAY_MS,
  overrides: Partial<CleanupThread> = {},
) => chat(id, copy, { settledOverride: "settled", settledAt: ago(idleMs), ...overrides }, idleMs);

const makeCleanup = (world: World) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* makeWorktreeCleanup({
      worktreesDir: world.worktreesDir,
      savedDir: world.savedDir,
      tempDir: nodePath.join(world.root, "tmp"),
      git: driver.execute,
      settings: Effect.sync(() => world.settings),
      readThreads: Effect.suspend(() => world.beforeReadThreads ?? Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => ({
            projects: [{ id: "project-1", workspaceRoot: world.repo }],
            threads: world.threads,
            deleted: world.deleted,
          })),
        ),
      ),
      getThread: (threadId) =>
        Effect.sync(() => {
          world.onGetThread?.(threadId);
          return world.threads.find((thread) => thread.id === threadId) ?? null;
        }),
      getProject: (projectId) =>
        Effect.sync(() =>
          projectId === "project-1" ? { id: projectId, workspaceRoot: world.repo } : null,
        ),
      liveSessions: Effect.sync(() => world.sessions),
      terminals: Effect.sync(() => world.terminals),
      diskSpace: () => Effect.sync(() => world.disk),
      now: () => NOW,
    });
  });

const entryFor = (report: StorageCleanupReport, threadId: string) => {
  const entry = report.entries.find((item) => item.threadId === threadId);
  if (entry === undefined) throw new Error(`no report entry for ${threadId}`);
  return entry;
};

const savedRefs = (world: World) =>
  gitSync(world.repo, ["for-each-ref", "--format=%(refname)", "refs/uno/saved/"]);

const realSleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

it.layer(TestLayer)("WorktreeCleanup", (it) => {
  describe("removal", () => {
    it.effect("removes the clean copy of a Done chat and keeps its branch", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const copy = addCopy(world, "done");
        const head = gitSync(copy.path, ["rev-parse", "HEAD"]);
        world.threads = [doneChat("thread-done", copy)];
        const cleanup = yield* makeCleanup(world);

        const report = yield* cleanup.runNow;

        expect(report.counts).toEqual({ removed: 1, kept: 0, failed: 0 });
        const entry = entryFor(report, "thread-done");
        expect(entry).toMatchObject({
          outcome: "removed",
          reason: "Done chat, quiet for 4 days",
          path: copy.path,
          saved: false,
        });
        expect(entry.bytes).toBeGreaterThan(60 * 1024);
        expect(report.bytesFreed).toBe(entry.bytes);
        expect(existsSync(copy.path)).toBe(false);
        expect(gitSync(world.repo, ["worktree", "list", "--porcelain"])).not.toContain(copy.path);
        expect(gitSync(world.repo, ["rev-parse", `refs/heads/${copy.branch}`])).toBe(head);
        expect(savedRefs(world)).toBe("");
        expect(existsSync(nodePath.join(world.savedDir, "thread-done"))).toBe(false);
        expect((yield* cleanup.status).report).toEqual(report);

        // The next message brings it back, clean, without node_modules.
        yield* cleanup.ensureThreadWorktree("thread-done");
        expect(gitSync(copy.path, ["symbolic-ref", "--short", "HEAD"])).toBe(copy.branch);
        expect(gitSync(copy.path, ["rev-parse", "HEAD"])).toBe(head);
        expect(statusLines(copy.path)).toEqual([]);
        expect(existsSync(nodePath.join(copy.path, "node_modules"))).toBe(false);
      }),
    );

    it.effect(
      "saves a dirty copy, removes it and brings it back with its changes and .env files",
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const copy = addCopy(world, "dirty");
          const head = gitSync(copy.path, ["rev-parse", "HEAD"]);
          write(nodePath.join(copy.path, "README.md"), "# App\n\nWork in progress.\n");
          rmSync(nodePath.join(copy.path, "notes.txt"));
          write(nodePath.join(copy.path, "src", "new.ts"), "export const answer = 42;\n");
          write(nodePath.join(copy.path, ".env"), "SECRET=one\n");
          write(
            nodePath.join(copy.path, "apps", "web", ".env.local"),
            "API_URL=http://localhost\n",
          );
          write(nodePath.join(copy.path, "dist", "bundle.js"), "built\n");
          const before = statusLines(copy.path);
          expect(before).toEqual([" D notes.txt", " M README.md", "?? src/new.ts"]);
          world.threads = [doneChat("thread-dirty", copy)];
          const cleanup = yield* makeCleanup(world);

          const report = yield* cleanup.runNow;

          expect(entryFor(report, "thread-dirty")).toMatchObject({
            outcome: "removed",
            saved: true,
          });
          expect(existsSync(copy.path)).toBe(false);
          expect(savedRefs(world)).toBe("refs/uno/saved/thread-dirty");
          expect(gitSync(world.repo, ["rev-parse", "refs/uno/saved/thread-dirty^1"])).toBe(head);
          const savedFolder = nodePath.join(world.savedDir, "thread-dirty");
          expect(statSync(savedFolder).mode & 0o777).toBe(0o700);
          expect(statSync(nodePath.join(savedFolder, "files", ".env")).mode & 0o777).toBe(0o600);
          // Branches are never moved or deleted.
          expect(gitSync(world.repo, ["rev-parse", `refs/heads/${copy.branch}`])).toBe(head);

          yield* cleanup.ensureThreadWorktree("thread-dirty");

          expect(statusLines(copy.path)).toEqual(before);
          expect(gitSync(copy.path, ["diff", "--cached", "--name-only"])).toBe("");
          expect(gitSync(copy.path, ["rev-parse", "HEAD"])).toBe(head);
          expect(readFileSync(nodePath.join(copy.path, "README.md"), "utf8")).toBe(
            "# App\n\nWork in progress.\n",
          );
          expect(existsSync(nodePath.join(copy.path, "notes.txt"))).toBe(false);
          expect(readFileSync(nodePath.join(copy.path, "src", "new.ts"), "utf8")).toBe(
            "export const answer = 42;\n",
          );
          expect(readFileSync(nodePath.join(copy.path, ".env"), "utf8")).toBe("SECRET=one\n");
          expect(readFileSync(nodePath.join(copy.path, "apps", "web", ".env.local"), "utf8")).toBe(
            "API_URL=http://localhost\n",
          );
          // Build output and dependencies are not saved.
          expect(existsSync(nodePath.join(copy.path, "dist"))).toBe(false);
          expect(existsSync(nodePath.join(copy.path, "node_modules"))).toBe(false);
          // Once everything is back, the saved copies are dropped.
          expect(savedRefs(world)).toBe("");
          expect(existsSync(savedFolder)).toBe(false);

          // Idempotent: the folder is there, nothing happens.
          yield* cleanup.ensureThreadWorktree("thread-dirty");
          expect(statusLines(copy.path)).toEqual(before);
        }),
    );

    it.effect("brings a copy back even when its branch was deleted meanwhile", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const copy = addCopy(world, "lost-branch");
        const head = gitSync(copy.path, ["rev-parse", "HEAD"]);
        write(nodePath.join(copy.path, "README.md"), "# App\n\nChanged.\n");
        world.threads = [doneChat("thread-lost", copy)];
        const cleanup = yield* makeCleanup(world);
        expect((yield* cleanup.runNow).counts.removed).toBe(1);
        gitSync(world.repo, ["branch", "-q", "-D", copy.branch]);

        yield* cleanup.ensureThreadWorktree("thread-lost");

        expect(gitSync(copy.path, ["rev-parse", "HEAD"])).toBe(head);
        expect(gitSync(copy.path, ["symbolic-ref", "--short", "HEAD"])).toBe(copy.branch);
        expect(statusLines(copy.path)).toEqual([" M README.md"]);
        expect(savedRefs(world)).toBe("");
      }),
    );

    it.effect("removes the copy of a deleted chat unless that rule is off", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const copy = addCopy(world, "deleted");
        world.deleted = [
          {
            id: "thread-deleted",
            title: "Old chat",
            branch: copy.branch,
            worktreePath: copy.path,
            workspaceRoot: world.repo,
          },
        ];
        world.settings = { ...world.settings, worktreeOnDelete: false };
        const cleanup = yield* makeCleanup(world);

        const off = yield* cleanup.runNow;
        expect(entryFor(off, "thread-deleted")).toMatchObject({
          outcome: "kept",
          reason: "Chat was deleted; cleanup on delete is off",
        });
        expect(existsSync(copy.path)).toBe(true);

        world.settings = { ...world.settings, worktreeOnDelete: true };
        const on = yield* cleanup.runNow;
        expect(entryFor(on, "thread-deleted")).toMatchObject({
          outcome: "removed",
          reason: "Chat was deleted",
        });
        expect(existsSync(copy.path)).toBe(false);
      }),
    );

    it.effect("is idempotent: a second pass finds nothing to do", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const copy = addCopy(world, "twice");
        world.threads = [doneChat("thread-twice", copy)];
        const cleanup = yield* makeCleanup(world);

        expect((yield* cleanup.runNow).counts).toEqual({ removed: 1, kept: 0, failed: 0 });
        const again = yield* cleanup.runNow;
        expect(again.counts).toEqual({ removed: 0, kept: 0, failed: 0 });
        expect(again.bytesFreed).toBe(0);
      }),
    );
  });

  describe("what is kept", () => {
    it.effect(
      "skips chats that are working, waiting, just used, or have a terminal or session open",
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const running = addCopy(world, "running");
          const waiting = addCopy(world, "waiting");
          const recent = addCopy(world, "recent");
          const terminal = addCopy(world, "terminal");
          const session = addCopy(world, "session");
          world.threads = [
            doneChat("thread-running", running, 4 * DAY_MS, {
              session: {
                threadId: ThreadId.make("thread-running"),
                status: "running",
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: TurnId.make("turn-now"),
                lastError: null,
                updatedAt: ago(60_000),
              },
            }),
            chat("thread-waiting", waiting, { hasPendingApprovals: true }, 30 * DAY_MS),
            doneChat("thread-recent", recent, 4 * DAY_MS, { settledAt: ago(60_000) }),
            doneChat("thread-terminal", terminal),
            doneChat("thread-session", session),
          ];
          world.terminals = [
            {
              threadId: "thread-other",
              cwd: nodePath.join(terminal.path, "src"),
              worktreePath: null,
              status: "running",
            },
          ];
          world.sessions = [{ threadId: "thread-session" }];
          world.disk = NEARLY_FULL;
          const cleanup = yield* makeCleanup(world);

          const report = yield* cleanup.runNow;

          expect(report.counts).toEqual({ removed: 0, kept: 5, failed: 0 });
          expect(entryFor(report, "thread-running").reason).toBe(
            "The agent is working in this chat",
          );
          expect(entryFor(report, "thread-waiting").reason).toBe(
            "The chat is waiting for your answer",
          );
          expect(entryFor(report, "thread-recent").reason).toBe("Used a few minutes ago");
          expect(entryFor(report, "thread-terminal").reason).toBe("A terminal is open in it");
          expect(entryFor(report, "thread-session").reason).toBe(
            "The agent's session is still open",
          );
          for (const copy of [running, waiting, recent, terminal, session]) {
            expect(existsSync(copy.path)).toBe(true);
          }
        }),
    );

    it.effect("keeps a copy whose branch was switched", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const copy = addCopy(world, "switched");
        gitSync(copy.path, ["checkout", "-q", "-b", "uno/other"]);
        world.threads = [doneChat("thread-switched", copy)];
        const cleanup = yield* makeCleanup(world);

        const report = yield* cleanup.runNow;

        expect(entryFor(report, "thread-switched")).toMatchObject({
          outcome: "kept",
          reason: "Its branch changed to uno/other",
        });
        expect(existsSync(copy.path)).toBe(true);
      }),
    );

    it.effect("keeps a copy two chats share", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const copy = addCopy(world, "shared");
        world.threads = [doneChat("thread-one", copy), doneChat("thread-two", copy)];
        const cleanup = yield* makeCleanup(world);

        const report = yield* cleanup.runNow;

        expect(report.counts).toEqual({ removed: 0, kept: 1, failed: 0 });
        expect(report.entries[0]?.reason).toBe("Shared by 2 chats");
        expect(existsSync(copy.path)).toBe(true);
      }),
    );

    it.effect("never touches folders outside <worktrees>/<repo>/<branch>", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const elsewhere = addCopy(
          world,
          "elsewhere",
          nodePath.join(world.root, "elsewhere", "copy"),
        );
        const deep = addCopy(
          world,
          "deep",
          nodePath.join(world.worktreesDir, "app", "deep", "copy"),
        );
        const linkPath = nodePath.join(world.worktreesDir, "app", "link");
        symlinkSync(elsewhere.path, linkPath);
        world.threads = [
          doneChat("thread-elsewhere", elsewhere),
          doneChat("thread-deep", deep),
          doneChat("thread-link", { path: linkPath, branch: elsewhere.branch }),
          // The project's own folder recorded as a chat copy.
          doneChat("thread-project", { path: world.repo, branch: "main" }),
        ];
        world.disk = NEARLY_FULL;
        const cleanup = yield* makeCleanup(world);

        const report = yield* cleanup.runNow;

        expect(report.counts).toEqual({ removed: 0, kept: 4, failed: 0 });
        expect(entryFor(report, "thread-elsewhere").reason).toBe(
          "It is outside the chat copies folder",
        );
        expect(entryFor(report, "thread-deep").reason).toBe("It is outside the chat copies folder");
        expect(entryFor(report, "thread-link").reason).toBe("It is a symbolic link");
        expect(entryFor(report, "thread-project").reason).toBe(
          "It is outside the chat copies folder",
        );
        expect(existsSync(nodePath.join(elsewhere.path, "README.md"))).toBe(true);
        expect(existsSync(nodePath.join(deep.path, "README.md"))).toBe(true);
        expect(existsSync(nodePath.join(world.repo, "README.md"))).toBe(true);

        // Nor brings one back there.
        const gone = nodePath.join(world.root, "elsewhere", "gone");
        world.threads = [doneChat("thread-gone", { path: gone, branch: "uno/gone" })];
        yield* cleanup.ensureThreadWorktree("thread-gone");
        expect(existsSync(gone)).toBe(false);
      }),
    );

    it.effect("keeps copies with changes when saving is off", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const dirty = addCopy(world, "unsaved");
        write(nodePath.join(dirty.path, "README.md"), "# Changed\n");
        const env = addCopy(world, "env-only");
        write(nodePath.join(env.path, ".env"), "SECRET=two\n");
        world.threads = [doneChat("thread-unsaved", dirty), doneChat("thread-env", env)];
        world.settings = { ...world.settings, worktreeSaveChanges: false };
        const cleanup = yield* makeCleanup(world);

        const report = yield* cleanup.runNow;

        expect(entryFor(report, "thread-unsaved").reason).toBe("It has uncommitted changes");
        expect(entryFor(report, "thread-env").reason).toBe("It has .env files");
        expect(existsSync(dirty.path)).toBe(true);
        expect(existsSync(env.path)).toBe(true);
        expect(savedRefs(world)).toBe("");
      }),
    );

    it.effect("checks the chat again right before removal", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const copy = addCopy(world, "revived");
        write(nodePath.join(copy.path, "README.md"), "# Changed\n");
        world.threads = [doneChat("thread-revived", copy)];
        // The person writes in the chat while the pass is measuring the copy.
        world.onGetThread = (threadId) => {
          world.threads = world.threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, settledOverride: null, latestUserMessageAt: ago(1000) }
              : thread,
          );
        };
        const cleanup = yield* makeCleanup(world);

        const report = yield* cleanup.runNow;

        expect(entryFor(report, "thread-revived")).toMatchObject({
          outcome: "kept",
          reason: "Used a few minutes ago",
        });
        expect(statusLines(copy.path)).toEqual([" M README.md"]);
        expect(savedRefs(world)).toBe("");
      }),
    );
  });

  describe("disk pressure", () => {
    it.effect(
      "removes Done chats right away and idle ones after 3 days when the disk is nearly full",
      () =>
        Effect.gen(function* () {
          const world = yield* makeWorld;
          const justDone = addCopy(world, "just-done");
          const idle = addCopy(world, "idle");
          const fresh = addCopy(world, "fresh");
          world.threads = [
            doneChat("thread-just-done", justDone, DAY_MS, { settledAt: ago(HOUR_MS) }),
            // Pinned: never auto-Done, only the idle rule applies.
            chat("thread-idle", idle, { pinnedAt: ago(10 * DAY_MS) }, 4 * DAY_MS),
            chat("thread-fresh", fresh, { pinnedAt: ago(10 * DAY_MS) }, 2 * DAY_MS),
          ];
          const cleanup = yield* makeCleanup(world);

          const roomy = yield* cleanup.runNow;
          expect(roomy.lowDisk).toBe(false);
          expect(roomy.counts).toEqual({ removed: 0, kept: 3, failed: 0 });
          expect(entryFor(roomy, "thread-just-done").reason).toBe("Done today");

          world.disk = NEARLY_FULL;
          world.settings = { ...world.settings, worktreeLowDisk: false };
          expect((yield* cleanup.runNow).counts.removed).toBe(0);

          world.settings = { ...world.settings, worktreeLowDisk: true };
          const full = yield* cleanup.runNow;
          expect(full.lowDisk).toBe(true);
          expect(full.counts).toEqual({ removed: 2, kept: 1, failed: 0 });
          expect(entryFor(full, "thread-just-done").reason).toBe(
            "Disk nearly full: Done chat, quiet for 1 day",
          );
          expect(entryFor(full, "thread-idle").reason).toBe(
            "Disk nearly full: not used for 4 days",
          );
          expect(entryFor(full, "thread-fresh").outcome).toBe("kept");
          expect(existsSync(justDone.path)).toBe(false);
          expect(existsSync(idle.path)).toBe(false);
          expect(existsSync(fresh.path)).toBe(true);
        }),
    );
  });

  describe("scheduling", () => {
    it.effect("never runs two passes at once", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const copy = addCopy(world, "queued");
        world.threads = [doneChat("thread-queued", copy)];
        const gate = yield* Deferred.make<void>();
        let calls = 0;
        let active = 0;
        let maxActive = 0;
        world.beforeReadThreads = Effect.suspend(() => {
          calls++;
          active++;
          maxActive = Math.max(maxActive, active);
          return (calls === 1 ? Deferred.await(gate) : Effect.void).pipe(
            Effect.ensuring(Effect.sync(() => active--)),
          );
        });
        const cleanup = yield* makeCleanup(world);

        const first = yield* Effect.forkChild(cleanup.runNow);
        while (calls === 0) yield* realSleep(10);
        const second = yield* Effect.forkChild(cleanup.runNow);
        yield* realSleep(200);
        expect(calls).toBe(1);
        expect((yield* cleanup.status).running).toBe(true);

        yield* Deferred.succeed(gate, undefined);
        const firstReport = yield* Fiber.join(first);
        const secondReport = yield* Fiber.join(second);

        expect(calls).toBe(2);
        expect(maxActive).toBe(1);
        expect(firstReport.counts.removed).toBe(1);
        expect(secondReport.counts).toEqual({ removed: 0, kept: 0, failed: 0 });
        expect((yield* cleanup.status).running).toBe(false);
      }),
    );
  });
});
