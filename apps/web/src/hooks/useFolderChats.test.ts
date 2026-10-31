import type { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const setEnabled = vi.hoisted(() => vi.fn());
const dispatchCommand = vi.hoisted(() => vi.fn());

vi.mock("../environmentApi", () => ({
  ensureEnvironmentApi: () => ({
    filesystem: { browse: async () => ({ parentPath: "/home/u" }) },
    projectSync: { setEnabled },
    orchestration: { dispatchCommand },
  }),
}));

import { ensureFolderProjectOn, resetHomeFolderCacheForTests } from "./useFolderChats";

const environmentId = "env-1" as EnvironmentId;
const folder = "/home/u/projects/private-notes";

describe("ensureFolderProjectOn", () => {
  beforeEach(() => {
    calls.length = 0;
    resetHomeFolderCacheForTests();
    setEnabled.mockReset().mockImplementation(async () => void calls.push("stay here"));
    dispatchCommand.mockReset().mockImplementation(async () => void calls.push("create project"));
  });

  it("says Only on this computer before the project exists, for the same project", async () => {
    const ref = await ensureFolderProjectOn(environmentId, folder, "notes", {
      keepHere: true,
      createFolder: true,
      providers: [],
    });
    expect(calls).toEqual(["stay here", "create project"]);
    expect(setEnabled).toHaveBeenCalledWith({ projectId: ref.projectId, enabled: false });
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "project.create",
      projectId: ref.projectId,
    });
  });

  it("still makes the project when the computer's older Work refuses that", async () => {
    setEnabled.mockRejectedValueOnce(new Error("This project isn't on this computer."));
    await ensureFolderProjectOn(environmentId, folder, "notes", { keepHere: true, providers: [] });
    expect(calls).toEqual(["create project"]);
  });

  it("leaves sync alone for every other project", async () => {
    await ensureFolderProjectOn(environmentId, folder, "notes", { providers: [] });
    expect(calls).toEqual(["create project"]);
  });
});
