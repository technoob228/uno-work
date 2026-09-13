import type {
  EnvironmentId,
  ProjectId,
  ThreadContinuePrepareResult,
  ThreadContinueReceiveResult,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  CONTINUE_ON_MACHINE_STEPS,
  ContinueOnMachineFailure,
  resolveContinueTargetProject,
  runContinueOnMachine,
  toReceiveProject,
  waitUntil,
  type ContinueOnMachineDeps,
  type ContinueOnMachineInput,
  type ContinueOnMachineStep,
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

const INPUT: ContinueOnMachineInput = {
  sourceThreadId: SOURCE_THREAD_ID,
  targetMachineLabel: "box-1",
  targetProject: { kind: "existing", projectPath: "/home/unowork/projects/uno", title: "uno" },
  copyEnv: true,
  archiveSource: false,
};

function makeDeps(overrides: Partial<ContinueOnMachineDeps> = {}) {
  const steps: ContinueOnMachineStep[] = [];
  const deps: ContinueOnMachineDeps = {
    ensureTargetConnected: vi.fn(async () => {}),
    prepare: vi.fn(async () => PREPARED),
    receive: vi.fn(async () => RECEIVED),
    complete: vi.fn(async () => ({ archived: false })),
    openThread: vi.fn(async () => {}),
    onStep: (step) => steps.push(step),
    ...overrides,
  };
  return { deps, steps };
}

describe("runContinueOnMachine", () => {
  it("runs connect → prepare (source) → receive (target) → complete (source) → open, in order", async () => {
    const { deps, steps } = makeDeps();

    const result = await runContinueOnMachine(deps, INPUT);

    expect(steps).toEqual(CONTINUE_ON_MACHINE_STEPS);
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
      completed: { archived: false },
    });
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
      completed: { archived: false },
    });

    await runContinueOnMachine(deps, INPUT, typed.progress);

    expect(deps.prepare).toHaveBeenCalledTimes(1);
    expect(deps.receive).toHaveBeenCalledTimes(1);
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
