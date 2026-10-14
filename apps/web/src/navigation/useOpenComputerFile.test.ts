import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { computerFileTab, computerFileTarget } from "./useOpenComputerFile";

describe("computerFileTarget", () => {
  it("opens beside the chat when in a chat and the panel can show it", () => {
    expect(computerFileTarget({ inChat: true, previewKind: "md", hasEnvironment: true })).toBe(
      "beside",
    );
    expect(computerFileTarget({ inChat: true, previewKind: "docx", hasEnvironment: true })).toBe(
      "beside",
    );
  });

  it("goes to Files outside a chat, for files the panel can't show, or with no computer", () => {
    expect(computerFileTarget({ inChat: false, previewKind: "md", hasEnvironment: true })).toBe(
      "files",
    );
    expect(computerFileTarget({ inChat: true, previewKind: "unknown", hasEnvironment: true })).toBe(
      "files",
    );
    expect(computerFileTarget({ inChat: true, previewKind: "md", hasEnvironment: false })).toBe(
      "files",
    );
  });
});

describe("computerFileTab", () => {
  it("is a right-panel file tab keyed by its path", () => {
    const environmentId = EnvironmentId.make("env-1");
    expect(computerFileTab("/home/u/docs/plan.md", environmentId)).toEqual({
      id: "/home/u/docs/plan.md",
      name: "plan.md",
      kind: "md",
      content: "",
      path: "/home/u/docs/plan.md",
      environmentId,
    });
  });
});
