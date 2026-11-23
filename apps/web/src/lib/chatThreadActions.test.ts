import { scopeProjectRef } from "@t3tools/client-runtime";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  resolveThreadActionProjectRef,
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
  startNewThreadInPickedProject,
  type ChatThreadActionContext,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");

function createContext(overrides: Partial<ChatThreadActionContext> = {}): ChatThreadActionContext {
  return {
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    defaultThreadEnvMode: "local",
    handleNewThread: async () => {},
    ...overrides,
  };
}

describe("chatThreadActions", () => {
  it("prefers the active draft thread project when resolving thread actions", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "feature/refactor",
          worktreePath: "/tmp/worktree",
          envMode: "worktree",
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the default project ref when there is no active thread context", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("starts a contextual new thread from the active draft thread", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "feature/refactor",
          worktreePath: "/tmp/worktree",
          envMode: "worktree",
        },
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      branch: "feature/refactor",
      worktreePath: "/tmp/worktree",
      envMode: "worktree",
    });
  });

  it("starts a local thread with the configured default env mode", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewLocalThreadFromContext(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
        defaultThreadEnvMode: "worktree",
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      envMode: "worktree",
    });
  });

  it("does not start a thread when there is no project context", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        defaultProjectRef: null,
        handleNewThread,
      }),
    );

    expect(didStart).toBe(false);
    expect(handleNewThread).not.toHaveBeenCalled();
  });

  it("invokes onMissingProject when no project context is available", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    const onMissingProject = vi.fn();

    const didStart = await startNewThreadFromContext(
      createContext({
        defaultProjectRef: null,
        handleNewThread,
        onMissingProject,
      }),
    );

    expect(didStart).toBe(false);
    expect(handleNewThread).not.toHaveBeenCalled();
    expect(onMissingProject).toHaveBeenCalledTimes(1);
  });

  it("invokes onMissingProject for the local thread fallback when no project is available", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    const onMissingProject = vi.fn();

    const didStart = await startNewLocalThreadFromContext(
      createContext({
        defaultProjectRef: null,
        handleNewThread,
        onMissingProject,
      }),
    );

    expect(didStart).toBe(false);
    expect(handleNewThread).not.toHaveBeenCalled();
    expect(onMissingProject).toHaveBeenCalledTimes(1);
  });

  describe("selected machine", () => {
    const PRIMARY = EnvironmentId.make("primary");
    const NEW_BOX = EnvironmentId.make("new-box");
    const PRIMARY_PROJECT = scopeProjectRef(PRIMARY, ProjectId.make("boost-9"));

    it("does not open a new chat on the primary machine when another machine is selected", async () => {
      // e2e 21.09: switch to a freshly connected box → New chat → landed on boost-9.
      const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
      const starter = scopeProjectRef(NEW_BOX, ProjectId.make("home"));
      const createStarterProject = vi.fn(async () => starter);

      const didStart = await startNewThreadFromContext(
        createContext({
          defaultProjectRef: PRIMARY_PROJECT,
          activeEnvironmentId: NEW_BOX,
          createStarterProject,
          handleNewThread,
        }),
      );

      expect(didStart).toBe(true);
      expect(createStarterProject).toHaveBeenCalledWith(NEW_BOX);
      expect(handleNewThread).toHaveBeenCalledWith(starter, expect.anything());
    });

    it("ignores a thread still open from another machine", () => {
      const projectRef = resolveThreadActionProjectRef(
        createContext({
          activeThread: {
            environmentId: PRIMARY,
            projectId: ProjectId.make("boost-9"),
            branch: null,
            worktreePath: null,
          },
          defaultProjectRef: scopeProjectRef(NEW_BOX, PROJECT_ID),
          activeEnvironmentId: NEW_BOX,
        }),
      );
      expect(projectRef).toEqual(scopeProjectRef(NEW_BOX, PROJECT_ID));
    });

    it("asks for a project instead of jumping machines when it cannot make one", async () => {
      const onMissingProject = vi.fn();
      const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
      const didStart = await startNewThreadFromContext(
        createContext({
          defaultProjectRef: PRIMARY_PROJECT,
          activeEnvironmentId: NEW_BOX,
          onMissingProject,
          handleNewThread,
        }),
      );
      expect(didStart).toBe(false);
      expect(onMissingProject).toHaveBeenCalled();
      expect(handleNewThread).not.toHaveBeenCalled();
    });
  });
});

describe("startNewThreadInPickedProject (the New chat picker)", () => {
  const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-2");
  const openThread = {
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    branch: "feature/existing",
    worktreePath: "/repo/.t3/worktrees/existing",
  };

  it("the open chat's project keeps its branch and worktree", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    await startNewThreadInPickedProject(
      createContext({ activeThread: openThread, handleNewThread, defaultThreadEnvMode: "local" }),
      scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
    );
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      branch: "feature/existing",
      worktreePath: "/repo/.t3/worktrees/existing",
      envMode: "worktree",
    });
  });

  it("the open draft's mode carries over", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    await startNewThreadInPickedProject(
      createContext({
        activeDraftThread: { ...openThread, worktreePath: null, branch: null, envMode: "worktree" },
        handleNewThread,
      }),
      scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
    );
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      branch: null,
      worktreePath: null,
      envMode: "worktree",
    });
  });

  it("another project starts in its own default mode, without the open chat's worktree", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    const defaultThreadEnvMode = vi.fn(() => "worktree" as const);
    await startNewThreadInPickedProject(
      createContext({ activeThread: openThread, handleNewThread, defaultThreadEnvMode }),
      scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    );
    expect(defaultThreadEnvMode).toHaveBeenCalledWith(
      scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    );
    expect(handleNewThread).toHaveBeenCalledWith(
      scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
      { envMode: "worktree" },
    );
  });

  it("the same project id on another computer doesn't borrow the worktree", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    await startNewThreadInPickedProject(
      createContext({ activeThread: openThread, handleNewThread, defaultThreadEnvMode: "local" }),
      scopeProjectRef(OTHER_ENVIRONMENT_ID, PROJECT_ID),
    );
    expect(handleNewThread).toHaveBeenCalledWith(
      scopeProjectRef(OTHER_ENVIRONMENT_ID, PROJECT_ID),
      {
        envMode: "local",
      },
    );
  });
});
