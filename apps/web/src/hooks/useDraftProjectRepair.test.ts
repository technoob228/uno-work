import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { draftProjectRepair } from "./useDraftProjectRepair";

const HOME = { id: ProjectId.make("home-id"), cwd: "/home/person" };
const draft = (projectId: string, logicalProjectKey = `env-1:${projectId}`) => ({
  environmentId: "env-1",
  projectId,
  logicalProjectKey,
});

describe("draftProjectRepair", () => {
  it("leaves a draft whose project is there", () => {
    expect(draftProjectRepair({ draft: draft("home-id"), projects: [HOME] })).toEqual({
      kind: "none",
    });
  });

  it("finds the project of a draft saved with the path for an id", () => {
    expect(
      draftProjectRepair({
        draft: draft("/home/person", "env-1:/home/person"),
        projects: [HOME],
      }),
    ).toEqual({ kind: "relink", projectId: "home-id" });
  });

  it("finds it by the logical key when only the id is gone", () => {
    expect(
      draftProjectRepair({ draft: draft("old-id", "env-1:/home/person"), projects: [HOME] }),
    ).toEqual({ kind: "relink", projectId: "home-id" });
  });

  it("moves a draft with no project left to the home folder", () => {
    expect(draftProjectRepair({ draft: draft("gone-id"), projects: [HOME] })).toEqual({
      kind: "move-home",
    });
    expect(
      draftProjectRepair({ draft: draft("/srv/gone", "env-1:/srv/gone"), projects: [HOME] }),
    ).toEqual({ kind: "move-home" });
  });
});
