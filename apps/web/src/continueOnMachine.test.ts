import type {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ProjectId,
  ThreadContinueInspectResult,
  ThreadContinueLandResult,
  ThreadContinueSnapshotResult,
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
  ContinueUpdateRequiredError,
  describeContinueTarget,
  describeHandoffSeed,
  descriptorSupportsDirectContinue,
  findMachineNeedingUpdate,
  inspectContinueTarget,
  isHandoffSeed,
  resolveContinueTargetProject,
  runContinueOnMachine,
  toLandProject,
  waitUntil,
  type ContinueOnMachineDeps,
  type ContinueOnMachineInput,
  type ContinueOnMachineStep,
  type ContinueTargetProject,
} from "./continueOnMachine";

const SOURCE_THREAD_ID = "thread-source" as ThreadId;
const TARGET_THREAD_ID = "thread-target" as ThreadId;
const TARGET_PROJECT_ID = "project-target" as ProjectId;
const TRANSFER_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

const SNAPSHOT: ThreadContinueSnapshotResult = {
  transferId: TRANSFER_ID,
  sourceThreadId: SOURCE_THREAD_ID,
  sourceMachineLabel: "Misha's Mac",
  sizeBytes: 10,
  sha256: "abc",
  chunkBytes: 4,
  chunkCount: 3,
  commit: "wipsha",
  baseCommit: "headsha",
  sourceBranch: "main",
  remoteUrl: "git@github.com:uno/uno.git",
  title: "Fix login",
  modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" } as never,
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
  seedText: "[Continued from Misha's Mac] seed",
  envText: null,
};

const LANDED: ThreadContinueLandResult = {
  projectId: TARGET_PROJECT_ID,
  threadId: TARGET_THREAD_ID,
  projectPath: "/home/unowork/projects/uno",
  worktreePath: "/home/unowork/.t3/worktrees/uno/uno-continue-thread-so",
  branch: "uno/continue/thread-so",
  projectCreated: false,
  modelSelection: SNAPSHOT.modelSelection,
  modelFallbackApplied: false,
  envWritten: false,
};

const INSPECT_EXISTS: ThreadContinueInspectResult = {
  projectPath: "/home/unowork/projects/uno",
  exists: true,
  isGitRepository: true,
  registered: true,
  hasLocalChanges: true,
  changedFiles: 3,
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
  copyEnv: false,
  archiveSource: false,
};

const BYTES = "0123456789";
const chunkOf = (index: number) => btoa(BYTES.slice(index * 4, index * 4 + 4));

function makeDeps(overrides: Partial<ContinueOnMachineDeps> = {}) {
  const steps: ContinueOnMachineStep[] = [];
  const written: Array<{ offset: number; data: string }> = [];
  const calls: string[] = [];
  const deps: ContinueOnMachineDeps = {
    ensureTargetConnected: vi.fn(async () => {
      calls.push("connect");
    }),
    assertMachinesSupported: vi.fn(() => {
      calls.push("assert");
    }),
    inspect: vi.fn(async () => INSPECT_EXISTS),
    snapshot: vi.fn(async () => {
      calls.push("snapshot");
      return SNAPSHOT;
    }),
    readChunk: vi.fn(async ({ index }) => {
      calls.push(`read:${index}`);
      return { data: chunkOf(index) };
    }),
    writeChunk: vi.fn(async ({ offset, data }) => {
      calls.push(`write:${offset}`);
      written.push({ offset, data });
      return { receivedBytes: offset + atob(data).length };
    }),
    land: vi.fn(async () => {
      calls.push("land");
      return LANDED;
    }),
    discardSource: vi.fn(async () => {
      calls.push("discard");
      return { removed: true };
    }),
    complete: vi.fn(async () => {
      calls.push("complete");
      return { archived: false };
    }),
    openThread: vi.fn(async () => {
      calls.push("open");
    }),
    onStep: (step) => steps.push(step),
    ...overrides,
  };
  return { deps, steps, written, calls };
}

const continueError = (reason: string, message = reason) =>
  Object.assign(new Error(message), { reason });

describe("runContinueOnMachine", () => {
  it("snapshots on the source, relays every chunk to the target, lands, discards, marks and opens, in order", async () => {
    const progress: Array<[number, number]> = [];
    const { deps, steps, written, calls } = makeDeps({
      onSendProgress: (sent, total) => progress.push([sent, total]),
    });
    const result = await runContinueOnMachine(deps, INPUT);

    expect(steps).toEqual(CONTINUE_ON_MACHINE_STEPS);
    expect(calls).toEqual([
      "connect",
      "assert",
      "snapshot",
      "read:0",
      "write:0",
      "read:1",
      "write:4",
      "read:2",
      "write:8",
      "land",
      "discard",
      "complete",
      "open",
    ]);
    expect(written.map((entry) => atob(entry.data)).join("")).toBe(BYTES);
    expect(progress.at(-1)).toEqual([10, 10]);
    expect(deps.snapshot).toHaveBeenCalledWith({ threadId: SOURCE_THREAD_ID, includeEnv: false });
    expect(deps.land).toHaveBeenCalledWith({
      transferId: TRANSFER_ID,
      sizeBytes: 10,
      sha256: "abc",
      commit: "wipsha",
      baseCommit: "headsha",
      project: { kind: "existing", projectPath: "/home/unowork/projects/uno" },
      title: "Fix login",
      modelSelection: SNAPSHOT.modelSelection,
      runtimeMode: "auto-accept-edits",
      interactionMode: "default",
      seedText: SNAPSHOT.seedText,
      envText: null,
      sourceMachineLabel: "Misha's Mac",
      sourceThreadId: SOURCE_THREAD_ID,
    });
    expect(deps.complete).toHaveBeenCalledWith({
      threadId: SOURCE_THREAD_ID,
      targetMachineLabel: "box-1",
      targetThreadId: TARGET_THREAD_ID,
      archive: false,
    });
    expect(result.landed.branch).toBe("uno/continue/thread-so");
  });

  it("asks for .env only with the checkbox on and passes it through", async () => {
    const withEnv = { ...SNAPSHOT, envText: "TOKEN=1\n" };
    const { deps } = makeDeps({ snapshot: vi.fn(async () => withEnv) });
    await runContinueOnMachine(deps, { ...INPUT, copyEnv: true, archiveSource: true });
    expect(deps.snapshot).toHaveBeenCalledWith({ threadId: SOURCE_THREAD_ID, includeEnv: true });
    expect(vi.mocked(deps.land).mock.calls[0]?.[0].envText).toBe("TOKEN=1\n");
    expect(vi.mocked(deps.complete).mock.calls[0]?.[0].archive).toBe(true);

    // Even if a source returned .env unasked, it is not forwarded without the tick.
    const { deps: unticked } = makeDeps({ snapshot: vi.fn(async () => withEnv) });
    await runContinueOnMachine(unticked, INPUT);
    expect(vi.mocked(unticked.land).mock.calls[0]?.[0].envText).toBeNull();
  });

  it("stops before touching either machine when one of them needs an update", async () => {
    const { deps, calls } = makeDeps({
      assertMachinesSupported: () => {
        throw new ContinueUpdateRequiredError("box-1");
      },
    });
    const failure = await runContinueOnMachine(deps, INPUT).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(ContinueOnMachineFailure);
    expect((failure as ContinueOnMachineFailure).step).toBe("connecting");
    expect((failure as ContinueOnMachineFailure).message).toContain("Update Uno Work on box-1");
    expect(calls).toEqual(["connect"]);
  });

  it("fills the clone request from the snapshot when the project must be added, even without a remote", async () => {
    const create: ContinueTargetProject = {
      kind: "create",
      destinationPath: "~/projects/uno",
      title: "uno",
    };
    const { deps } = makeDeps({ snapshot: vi.fn(async () => ({ ...SNAPSHOT, remoteUrl: null })) });
    await runContinueOnMachine(deps, { ...INPUT, targetProject: create });
    expect(vi.mocked(deps.land).mock.calls[0]?.[0].project).toEqual({
      kind: "create",
      remoteUrl: null,
      destinationPath: "~/projects/uno",
      title: "uno",
    });
    expect(toLandProject(EXISTING_TARGET, "x")).toEqual({
      kind: "existing",
      projectPath: "/home/unowork/projects/uno",
    });
  });

  it("resumes sending at the first chunk that did not arrive, without a new snapshot", async () => {
    let failOnce = true;
    const first = makeDeps({
      writeChunk: vi.fn(async ({ offset, data }) => {
        if (offset === 4 && failOnce) {
          failOnce = false;
          throw new Error("socket closed");
        }
        return { receivedBytes: offset + atob(data).length };
      }),
    });
    const failure = (await runContinueOnMachine(first.deps, INPUT).catch(
      (caught: unknown) => caught,
    )) as ContinueOnMachineFailure;
    expect(failure.step).toBe("sending");
    expect(failure.progress.sentChunks).toBe(1);
    expect(failure.progress.snapshot).toEqual(SNAPSHOT);

    const retry = makeDeps();
    await runContinueOnMachine(retry.deps, INPUT, failure.progress);
    expect(retry.deps.snapshot).not.toHaveBeenCalled();
    expect(retry.calls.filter((call) => call.startsWith("write:"))).toEqual(["write:4", "write:8"]);
  });

  it("starts the upload over once when the target lost the partial file", async () => {
    let lost = true;
    const { deps, calls } = makeDeps({
      writeChunk: vi.fn(async ({ offset, data }) => {
        calls.push(`write:${offset}`);
        if (offset === 8 && lost) {
          lost = false;
          throw continueError("transfer_incomplete");
        }
        return { receivedBytes: offset + atob(data).length };
      }),
    });
    await runContinueOnMachine(deps, INPUT);
    expect(calls.filter((call) => call.startsWith("write:"))).toEqual([
      "write:0",
      "write:4",
      "write:8",
      "write:0",
      "write:4",
      "write:8",
    ]);
  });

  it("forgets the snapshot when the source no longer has the bundle, so a retry takes a new one", async () => {
    const { deps } = makeDeps({
      readChunk: vi.fn(async () => {
        throw continueError("transfer_not_found");
      }),
    });
    const failure = (await runContinueOnMachine(deps, INPUT).catch(
      (caught: unknown) => caught,
    )) as ContinueOnMachineFailure;
    expect(failure.step).toBe("sending");
    expect(failure.progress.snapshot).toBeUndefined();
  });

  it("sends the files again on retry when the target says they arrived damaged", async () => {
    const { deps } = makeDeps({
      land: vi.fn(async () => {
        throw continueError("transfer_incomplete");
      }),
    });
    const failure = (await runContinueOnMachine(deps, INPUT).catch(
      (caught: unknown) => caught,
    )) as ContinueOnMachineFailure;
    expect(failure.step).toBe("preparing");
    expect(failure.progress.sentChunks).toBe(0);
    expect(failure.progress.snapshot).toEqual(SNAPSHOT);
  });

  it("keeps going when the source bundle cannot be discarded", async () => {
    const { deps } = makeDeps({
      discardSource: vi.fn(async () => {
        throw new Error("gone");
      }),
    });
    const result = await runContinueOnMachine(deps, INPUT);
    expect(result.completed).toEqual({ archived: false });
    expect(deps.openThread).toHaveBeenCalled();
  });

  it("retries only the opening step once the thread exists on the target", async () => {
    const { deps, calls } = makeDeps();
    await runContinueOnMachine(deps, INPUT, {
      snapshot: SNAPSHOT,
      sentChunks: 3,
      landed: LANDED,
      completed: { archived: false },
    });
    expect(calls).toEqual(["connect", "assert", "open"]);
  });

  it("uses a readable message for non-Error failures", async () => {
    const { deps } = makeDeps({
      snapshot: vi.fn(async () => {
        throw { message: "not a git repository" };
      }),
    });
    const failure = (await runContinueOnMachine(deps, INPUT).catch(
      (caught: unknown) => caught,
    )) as ContinueOnMachineFailure;
    expect(failure.step).toBe("saving");
    expect(failure.message).toBe("not a git repository");

    const { deps: silent } = makeDeps({
      snapshot: vi.fn(async () => {
        throw 42;
      }),
    });
    const silentFailure = (await runContinueOnMachine(silent, INPUT).catch(
      (caught: unknown) => caught,
    )) as ContinueOnMachineFailure;
    expect(silentFailure.message).toBe("Something went wrong.");
  });
});

describe("protocol support", () => {
  const descriptor = (threadContinueDirect?: boolean) =>
    ({
      environmentId: "env",
      label: "box",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.57",
      capabilities: {
        repositoryIdentity: true,
        ...(threadContinueDirect === undefined ? {} : { threadContinueDirect }),
      },
    }) as ExecutionEnvironmentDescriptor;

  it("only trusts machines that advertise the direct protocol", () => {
    expect(descriptorSupportsDirectContinue(descriptor(true))).toBe(true);
    expect(descriptorSupportsDirectContinue(descriptor())).toBe(false);
    expect(descriptorSupportsDirectContinue(null)).toBe(false);
    expect(
      findMachineNeedingUpdate([
        { label: "Mac", descriptor: descriptor(true) },
        { label: "old box", descriptor: descriptor() },
      ]),
    ).toBe("old box");
    expect(findMachineNeedingUpdate([{ label: "Mac", descriptor: descriptor(true) }])).toBeNull();
    expect(findMachineNeedingUpdate([{ label: "unknown", descriptor: undefined }])).toBe("unknown");
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
        return INSPECT_EXISTS;
      }),
    };
    const result = await inspectContinueTarget(deps, {
      kind: "create",
      destinationPath: "~/projects/uno",
      title: "uno",
    });
    expect(order).toEqual(["connect", "inspect"]);
    expect(deps.inspect).toHaveBeenCalledWith({ projectPath: "~/projects/uno" });
    expect(result).toBe(INSPECT_EXISTS);
  });

  it("surfaces a connection failure instead of guessing", async () => {
    const deps = {
      ensureTargetConnected: vi.fn(async () => {
        throw new Error("offline");
      }),
      inspect: vi.fn(async () => INSPECT_EXISTS),
    };
    await expect(inspectContinueTarget(deps, EXISTING_TARGET)).rejects.toThrow("offline");
    expect(deps.inspect).not.toHaveBeenCalled();
  });
});

describe("describeContinueTarget / canStartContinue", () => {
  const missing: ThreadContinueInspectResult = {
    ...INSPECT_EXISTS,
    exists: false,
    isGitRepository: false,
    hasLocalChanges: false,
    changedFiles: 0,
    branch: null,
  };

  it("says the project will be added when nothing is at the path", () => {
    const target: ContinueTargetProject = {
      kind: "create",
      destinationPath: "~/projects/uno",
      title: "uno",
    };
    const state = describeContinueTarget(missing, target);
    expect(state).toEqual({ kind: "missing", destinationPath: "~/projects/uno" });
    expect(canStartContinue({ targetState: state, machineNeedingUpdate: null })).toBe(true);
  });

  it("refuses a folder that exists but is not a repository", () => {
    const state = describeContinueTarget(
      { ...missing, exists: true, projectPath: "/srv/uno" },
      EXISTING_TARGET,
    );
    expect(state).toEqual({ kind: "not-git", projectPath: "/srv/uno" });
    expect(canStartContinue({ targetState: state, machineNeedingUpdate: null })).toBe(false);
  });

  it("needs no confirmation for local changes on the target, since nothing there is replaced", () => {
    const state = describeContinueTarget(INSPECT_EXISTS, EXISTING_TARGET);
    expect(state).toEqual({ kind: "exists", projectPath: "/home/unowork/projects/uno" });
    expect(canStartContinue({ targetState: state, machineNeedingUpdate: null })).toBe(true);
  });

  it("keeps the button disabled until inspected, and while a machine needs an update", () => {
    expect(canStartContinue({ targetState: null, machineNeedingUpdate: null })).toBe(false);
    expect(
      canStartContinue({
        targetState: { kind: "exists", projectPath: "/x" },
        machineNeedingUpdate: "box-1",
      }),
    ).toBe(false);
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
