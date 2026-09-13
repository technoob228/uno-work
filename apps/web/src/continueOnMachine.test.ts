import type {
  EnvironmentId,
  ProjectId,
  ThreadContinueCleanupResult,
  ThreadContinueInspectResult,
  ThreadContinuePrepareResult,
  ThreadContinueReceiveResult,
  ThreadId,
} from "@t3tools/contracts";
import {
  CONTINUE_SEED_PREFIX,
  HANDOFF_PREAMBLE_END,
  HANDOFF_PREAMBLE_START,
  LEGACY_TELEGRAM_HANDOFF_PREAMBLE_START,
} from "@t3tools/shared/handoff";
import { describe, expect, it, vi } from "vitest";

import {
  CONTINUE_ON_MACHINE_STEPS,
  canStartContinue,
  ContinueOnMachineFailure,
  describeContinueTarget,
  describeHandoffSeed,
  inspectContinueTarget,
  isHandoffSeed,
  resolveContinueTargetProject,
  runContinueOnMachine,
  toReceiveProject,
  waitUntil,
  type ContinueOnMachineDeps,
  type ContinueOnMachineInput,
  type ContinueOnMachineStep,
  type ContinueTargetProject,
} from "./continueOnMachine";

const SOURCE_THREAD_ID = "thread-source" as ThreadId;
const TARGET_THREAD_ID = "thread-target" as ThreadId;
const TARGET_PROJECT_ID = "project-target" as ProjectId;

const PREPARED: ThreadContinuePrepareResult = {
  sourceThreadId: SOURCE_THREAD_ID,
  sourceMachineLabel: "Misha's Mac",
  remoteUrl: "git@github.com:uno/uno.git",
  remoteName: "origin",
  branch: "uno/continue/thread-source",
  commit: "wipsha",
  baseCommit: "headsha",
  sourceBranch: "main",
  title: "Fix login",
  modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" } as never,
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
  seedText: "[Continued from Misha's Mac] seed",
  envText: "TOKEN=1\n",
};

const RECEIVED: ThreadContinueReceiveResult = {
  projectId: TARGET_PROJECT_ID,
  threadId: TARGET_THREAD_ID,
  projectPath: "/home/unowork/projects/uno",
  projectCreated: false,
  modelSelection: PREPARED.modelSelection,
  modelFallbackApplied: false,
  envWritten: true,
};

const CLEANED: ThreadContinueCleanupResult = { branch: PREPARED.branch, removed: true };

const INSPECT_CLEAN: ThreadContinueInspectResult = {
  projectPath: "/home/unowork/projects/uno",
  exists: true,
  isGitRepository: true,
  registered: true,
  hasLocalChanges: false,
  changedFiles: 0,
  branch: "main",
};

const EXISTING_TARGET: ContinueTargetProject = {
  kind: "existing",
  projectPath: "/home/unowork/projects/uno",
  title: "uno",
};

const INPUT: ContinueOnMachineInput = {
  sourceThreadId: SOURCE_THREAD_ID,
  targetMachineLabel: "box-1",
  targetProject: EXISTING_TARGET,
  copyEnv: true,
  archiveSource: false,
};

function makeDeps(overrides: Partial<ContinueOnMachineDeps> = {}) {
  const steps: ContinueOnMachineStep[] = [];
  const deps: ContinueOnMachineDeps = {
    ensureTargetConnected: vi.fn(async () => {}),
    inspect: vi.fn(async () => INSPECT_CLEAN),
    prepare: vi.fn(async () => PREPARED),
    receive: vi.fn(async () => RECEIVED),
    cleanup: vi.fn(async () => CLEANED),
    complete: vi.fn(async () => ({ archived: false })),
    openThread: vi.fn(async () => {}),
    onStep: (step) => steps.push(step),
    ...overrides,
  };
  return { deps, steps };
}

describe("runContinueOnMachine", () => {
  it("runs connect → prepare (source) → receive (target) → cleanup (source) → complete (source) → open, in order", async () => {
    const { deps, steps } = makeDeps();

    const result = await runContinueOnMachine(deps, INPUT);

    expect(steps).toEqual(CONTINUE_ON_MACHINE_STEPS);
    expect(deps.cleanup).toHaveBeenCalledWith({ threadId: SOURCE_THREAD_ID, remote: "origin" });
    expect(deps.prepare).toHaveBeenCalledWith({ threadId: SOURCE_THREAD_ID, includeEnv: true });
    expect(deps.receive).toHaveBeenCalledWith({
      project: { kind: "existing", projectPath: "/home/unowork/projects/uno" },
      remoteUrl: PREPARED.remoteUrl,
      branch: PREPARED.branch,
      commit: PREPARED.commit,
      title: PREPARED.title,
      modelSelection: PREPARED.modelSelection,
      runtimeMode: PREPARED.runtimeMode,
      interactionMode: PREPARED.interactionMode,
      seedText: PREPARED.seedText,
      envText: "TOKEN=1\n",
      sourceMachineLabel: "Misha's Mac",
      sourceThreadId: SOURCE_THREAD_ID,
    });
    expect(deps.complete).toHaveBeenCalledWith({
      threadId: SOURCE_THREAD_ID,
      targetMachineLabel: "box-1",
      targetThreadId: TARGET_THREAD_ID,
      archive: false,
    });
    expect(deps.openThread).toHaveBeenCalledWith({
      threadId: TARGET_THREAD_ID,
      projectId: TARGET_PROJECT_ID,
    });
    expect(result).toEqual({
      prepared: PREPARED,
      received: RECEIVED,
      cleanedUp: CLEANED,
      completed: { archived: false },
    });
  });

  it("keeps going when the transfer branch cannot be removed, and reports it", async () => {
    const rejected = makeDeps({
      cleanup: vi.fn(async () => {
        throw new Error("remote hung up");
      }),
    });
    const rejectedResult = await runContinueOnMachine(rejected.deps, INPUT);
    expect(rejectedResult.cleanedUp).toEqual({ branch: PREPARED.branch, removed: false });
    expect(rejected.deps.complete).toHaveBeenCalledTimes(1);
    expect(rejected.deps.openThread).toHaveBeenCalledTimes(1);
    expect(rejected.steps).toEqual(CONTINUE_ON_MACHINE_STEPS);

    const declined = makeDeps({
      cleanup: vi.fn(async () => ({ branch: PREPARED.branch, removed: false })),
    });
    const declinedResult = await runContinueOnMachine(declined.deps, INPUT);
    expect(declinedResult.cleanedUp.removed).toBe(false);
    expect(declined.deps.complete).toHaveBeenCalledTimes(1);
  });

  it("does not try the cleanup again when a later step is retried", async () => {
    const complete = vi
      .fn<ContinueOnMachineDeps["complete"]>()
      .mockRejectedValueOnce(new Error("source asleep"))
      .mockResolvedValueOnce({ archived: false });
    const { deps } = makeDeps({ complete });

    const first = (await runContinueOnMachine(deps, INPUT).catch(
      (error: unknown) => error,
    )) as ContinueOnMachineFailure;
    expect(first.step).toBe("marking");
    expect(first.progress).toEqual({ prepared: PREPARED, received: RECEIVED, cleanedUp: CLEANED });

    await runContinueOnMachine(deps, INPUT, first.progress);
    expect(deps.cleanup).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not send .env when the checkbox is off, and passes the archive flag through", async () => {
    const { deps } = makeDeps({ complete: vi.fn(async () => ({ archived: true })) });

    await runContinueOnMachine(deps, { ...INPUT, copyEnv: false, archiveSource: true });

    expect(deps.prepare).toHaveBeenCalledWith({ threadId: SOURCE_THREAD_ID, includeEnv: false });
    expect(vi.mocked(deps.receive).mock.calls[0]?.[0]?.envText).toBeNull();
    expect(vi.mocked(deps.complete).mock.calls[0]?.[0]?.archive).toBe(true);
  });

  it("fills the clone request from the prepare result when the project must be created", async () => {
    const { deps } = makeDeps();
    await runContinueOnMachine(deps, {
      ...INPUT,
      targetProject: { kind: "create", destinationPath: "~/projects/uno", title: "uno" },
    });
    expect(vi.mocked(deps.receive).mock.calls[0]?.[0]?.project).toEqual({
      kind: "create",
      remoteUrl: PREPARED.remoteUrl,
      destinationPath: "~/projects/uno",
      title: "uno",
    });
    expect(
      toReceiveProject({ kind: "existing", projectPath: "/p", title: "p" }, "ignored"),
    ).toEqual({ kind: "existing", projectPath: "/p" });
  });

  it("reports the failed step with the progress so far", async () => {
    const { deps, steps } = makeDeps({
      receive: vi.fn(async () => {
        throw new Error("fetch refused");
      }),
    });

    const failure = await runContinueOnMachine(deps, INPUT).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ContinueOnMachineFailure);
    const typed = failure as ContinueOnMachineFailure;
    expect(typed.step).toBe("preparing");
    expect(typed.message).toBe("fetch refused");
    expect(typed.progress).toEqual({ prepared: PREPARED });
    expect(steps).toEqual(["connecting", "saving", "preparing"]);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
  });

  it("resumes from the failed step on retry without pushing again", async () => {
    const receive = vi
      .fn<ContinueOnMachineDeps["receive"]>()
      .mockRejectedValueOnce(new Error("box asleep"))
      .mockResolvedValueOnce(RECEIVED);
    const { deps, steps } = makeDeps({ receive });

    const first = await runContinueOnMachine(deps, INPUT).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(ContinueOnMachineFailure);

    const result = await runContinueOnMachine(
      deps,
      INPUT,
      (first as ContinueOnMachineFailure).progress,
    );

    expect(deps.prepare).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(deps.complete).toHaveBeenCalledTimes(1);
    expect(result.received).toEqual(RECEIVED);
    // The connection is re-checked on every attempt.
    expect(deps.ensureTargetConnected).toHaveBeenCalledTimes(2);
    expect(steps).toEqual([
      "connecting",
      "saving",
      "preparing",
      "connecting",
      "preparing",
      "cleaning",
      "marking",
      "opening",
    ]);
  });

  it("retries only the opening step once the thread exists on the target", async () => {
    const openThread = vi
      .fn<ContinueOnMachineDeps["openThread"]>()
      .mockRejectedValueOnce(new Error("not yet"))
      .mockResolvedValueOnce(undefined);
    const { deps } = makeDeps({ openThread });

    const first = await runContinueOnMachine(deps, INPUT).catch((error: unknown) => error);
    const typed = first as ContinueOnMachineFailure;
    expect(typed.step).toBe("opening");
    expect(typed.progress).toEqual({
      prepared: PREPARED,
      received: RECEIVED,
      cleanedUp: CLEANED,
      completed: { archived: false },
    });

    await runContinueOnMachine(deps, INPUT, typed.progress);

    expect(deps.prepare).toHaveBeenCalledTimes(1);
    expect(deps.receive).toHaveBeenCalledTimes(1);
    expect(deps.cleanup).toHaveBeenCalledTimes(1);
    expect(deps.complete).toHaveBeenCalledTimes(1);
    expect(openThread).toHaveBeenCalledTimes(2);
  });

  it("uses a readable message for non-Error failures", async () => {
    const { deps } = makeDeps({
      prepare: vi.fn(async () => {
        throw {
          _tag: "ThreadContinueError",
          message: "Add a git remote first.",
          reason: "no_remote",
        };
      }),
    });
    const failure = (await runContinueOnMachine(deps, INPUT).catch(
      (error: unknown) => error,
    )) as ContinueOnMachineFailure;
    expect(failure.step).toBe("saving");
    expect(failure.message).toBe("Add a git remote first.");
  });
});

describe("inspectContinueTarget", () => {
  it("connects first, then asks the target about the folder the chat would land in", async () => {
    const order: string[] = [];
    const deps = {
      ensureTargetConnected: vi.fn(async () => {
        order.push("connect");
      }),
      inspect: vi.fn(async () => {
        order.push("inspect");
        return INSPECT_CLEAN;
      }),
    };

    expect(await inspectContinueTarget(deps, EXISTING_TARGET)).toEqual(INSPECT_CLEAN);
    expect(order).toEqual(["connect", "inspect"]);
    expect(deps.inspect).toHaveBeenCalledWith({ projectPath: "/home/unowork/projects/uno" });

    await inspectContinueTarget(deps, {
      kind: "create",
      destinationPath: "~/projects/uno",
      title: "uno",
    });
    expect(deps.inspect).toHaveBeenLastCalledWith({ projectPath: "~/projects/uno" });
  });

  it("surfaces a connection failure instead of guessing", async () => {
    const deps = {
      ensureTargetConnected: vi.fn(async () => {
        throw new Error("box-1 is offline");
      }),
      inspect: vi.fn(async () => INSPECT_CLEAN),
    };
    await expect(inspectContinueTarget(deps, EXISTING_TARGET)).rejects.toThrow("box-1 is offline");
    expect(deps.inspect).not.toHaveBeenCalled();
  });
});

describe("describeContinueTarget / canStartContinue", () => {
  const createTarget: ContinueTargetProject = {
    kind: "create",
    destinationPath: "~/projects/uno",
    title: "uno",
  };

  it("says the project will be cloned when nothing is at the path", () => {
    const state = describeContinueTarget(
      { ...INSPECT_CLEAN, exists: false, isGitRepository: false, registered: false, branch: null },
      createTarget,
    );
    expect(state).toEqual({ kind: "missing", destinationPath: "~/projects/uno" });
    expect(canStartContinue({ targetState: state, replaceConfirmed: false })).toBe(true);
  });

  it("refuses a folder that exists but is not a repository", () => {
    const state = describeContinueTarget(
      { ...INSPECT_CLEAN, isGitRepository: false, branch: null },
      createTarget,
    );
    expect(state).toEqual({ kind: "not-git", projectPath: "/home/unowork/projects/uno" });
    expect(canStartContinue({ targetState: state, replaceConfirmed: true })).toBe(false);
  });

  it("lets a clean checkout through without confirmation", () => {
    const state = describeContinueTarget(INSPECT_CLEAN, EXISTING_TARGET);
    expect(state).toEqual({ kind: "clean", branch: "main" });
    expect(canStartContinue({ targetState: state, replaceConfirmed: false })).toBe(true);
  });

  it("requires the Replace them checkbox when the target has local changes", () => {
    const state = describeContinueTarget(
      { ...INSPECT_CLEAN, hasLocalChanges: true, changedFiles: 3 },
      EXISTING_TARGET,
    );
    expect(state).toEqual({ kind: "changes", changedFiles: 3, branch: "main" });
    expect(canStartContinue({ targetState: state, replaceConfirmed: false })).toBe(false);
    expect(canStartContinue({ targetState: state, replaceConfirmed: true })).toBe(true);
  });

  it("keeps the button disabled until the target has been inspected", () => {
    expect(canStartContinue({ targetState: null, replaceConfirmed: true })).toBe(false);
  });
});

describe("handoff seed detection", () => {
  const transcript = [
    "User: please fix login",
    "Assistant: done, see auth.ts",
    "User: now the tests",
  ].join("\n");
  const continueSeed = [
    `${CONTINUE_SEED_PREFIX}Misha's Mac] This chat continues "Fix login" from Misha's Mac on branch "main". Pick up where the conversation left off.`,
    "",
    HANDOFF_PREAMBLE_START,
    transcript,
    HANDOFF_PREAMBLE_END,
  ].join("\n");
  const telegramSeed = [
    HANDOFF_PREAMBLE_START,
    transcript,
    HANDOFF_PREAMBLE_END,
    "what next?",
  ].join("\n");

  it("recognises continue seeds and Telegram handoffs, but not ordinary messages", () => {
    expect(isHandoffSeed(continueSeed)).toBe(true);
    expect(isHandoffSeed(telegramSeed)).toBe(true);
    expect(isHandoffSeed(`${LEGACY_TELEGRAM_HANDOFF_PREAMBLE_START}\nUser: hi`)).toBe(true);
    expect(isHandoffSeed(`${CONTINUE_SEED_PREFIX}box-1] This chat continues "x" from box-1.`)).toBe(
      false,
    );
    expect(isHandoffSeed("please fix login")).toBe(false);
    // A preamble quoted in the middle of a message is the person's own text.
    expect(isHandoffSeed(`look at this:\n${HANDOFF_PREAMBLE_START}\nUser: hi`)).toBe(false);
  });

  it("summarises the seed for the collapsed card", () => {
    expect(describeHandoffSeed(continueSeed)).toEqual({
      sourceMachineLabel: "Misha's Mac",
      earlierMessages: 3,
      tail: "",
    });
    expect(describeHandoffSeed(telegramSeed)).toEqual({
      sourceMachineLabel: null,
      earlierMessages: 3,
      tail: "what next?",
    });
    // A model-fallback note appended by the receiver stays visible.
    expect(describeHandoffSeed(`${continueSeed}\n\n[Note: runs on codex here.]`).tail).toBe(
      "[Note: runs on codex here.]",
    );
  });
});

describe("resolveContinueTargetProject", () => {
  const targetEnvironmentId = "env-box" as EnvironmentId;
  const sourceProject = {
    name: "My App",
    repositoryIdentity: {
      canonicalKey: "github.com/uno/my-app",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:uno/my-app.git",
      },
    },
  };

  it("reuses a project on the target that points at the same remote", () => {
    const projects = [
      {
        environmentId: "env-mac" as EnvironmentId,
        cwd: "/Users/me/my-app",
        name: "My App",
        repositoryIdentity: sourceProject.repositoryIdentity,
      },
      {
        environmentId: targetEnvironmentId,
        cwd: "/home/unowork/projects/my-app",
        name: "my-app",
        repositoryIdentity: {
          canonicalKey: "github.com/uno/my-app",
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: "https://github.com/uno/my-app.git",
          },
        },
      },
    ];
    expect(
      resolveContinueTargetProject({
        sourceProject,
        targetEnvironmentId,
        projects,
        targetBaseDirectory: "~/projects",
      }),
    ).toEqual({ kind: "existing", projectPath: "/home/unowork/projects/my-app", title: "my-app" });
  });

  it("matches by normalized remote URL when a canonical key is missing", () => {
    const projects = [
      {
        environmentId: targetEnvironmentId,
        cwd: "/srv/my-app",
        name: "my-app",
        repositoryIdentity: {
          canonicalKey: "",
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: "https://github.com/UNO/My-App",
          },
        },
      },
    ];
    expect(
      resolveContinueTargetProject({
        sourceProject: {
          name: "My App",
          repositoryIdentity: {
            canonicalKey: "",
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: "git@github.com:uno/my-app.git",
            },
          },
        },
        targetEnvironmentId,
        projects,
        targetBaseDirectory: "~/projects",
      }),
    ).toEqual({ kind: "existing", projectPath: "/srv/my-app", title: "my-app" });
  });

  it("falls back to cloning under the target's project folder, named like Move to a box", () => {
    expect(
      resolveContinueTargetProject({
        sourceProject,
        targetEnvironmentId,
        projects: [],
        targetBaseDirectory: "~/projects",
      }),
    ).toEqual({ kind: "create", destinationPath: "~/projects/My-App", title: "My-App" });
    expect(
      resolveContinueTargetProject({
        sourceProject: { name: "no-git", repositoryIdentity: null },
        targetEnvironmentId,
        projects: [],
        targetBaseDirectory: "/srv",
      }),
    ).toEqual({ kind: "create", destinationPath: "/srv/no-git", title: "no-git" });
  });
});

describe("waitUntil", () => {
  it("resolves once the check passes and false at the deadline", async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 20);
    expect(await waitUntil(() => ready, { timeoutMs: 1_000, intervalMs: 5 })).toBe(true);
    expect(await waitUntil(() => false, { timeoutMs: 30, intervalMs: 5 })).toBe(false);
  });
});
