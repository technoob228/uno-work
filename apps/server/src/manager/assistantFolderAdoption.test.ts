import { describe, expect, it } from "@effect/vitest";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import {
  assistantFolderIdBase,
  isProjectAlreadyExists,
  makeAdoptionFailureLimiter,
} from "./assistantFolderAdoption.ts";
import { ManagerAssistantError } from "./Services/AssistantService.ts";

const alreadyExists = (projectId: string) =>
  new OrchestrationCommandInvariantError({
    commandType: "project.create",
    detail: `Project '${projectId}' already exists and cannot be created twice.`,
  });

describe("assistantFolderIdBase", () => {
  it("does not double the prefix of a folder named by the older convention", () => {
    expect(assistantFolderIdBase("assistant-a4e99f")).toBe("a4e99f");
  });

  it("keeps any other name as it is", () => {
    expect(assistantFolderIdBase("assistant")).toBe("assistant");
    expect(assistantFolderIdBase("research")).toBe("research");
  });
});

describe("isProjectAlreadyExists", () => {
  it("matches the invariant itself and wrapped by the assistant service", () => {
    expect(isProjectAlreadyExists(alreadyExists("assistant-x"), "assistant-x")).toBe(true);
    const wrapped = new ManagerAssistantError({
      detail: "Failed to ensure assistant assistant-x.",
      cause: alreadyExists("assistant-x"),
    });
    expect(isProjectAlreadyExists(wrapped, "assistant-x")).toBe(true);
  });

  it("does not match another project, another command or another error", () => {
    expect(isProjectAlreadyExists(alreadyExists("assistant-y"), "assistant-x")).toBe(false);
    const otherCommand = new OrchestrationCommandInvariantError({
      commandType: "thread.create",
      detail: "Project 'assistant-x' already exists and cannot be created twice.",
    });
    expect(isProjectAlreadyExists(otherCommand, "assistant-x")).toBe(false);
    expect(
      isProjectAlreadyExists(new ManagerAssistantError({ detail: "disk full" }), "assistant-x"),
    ).toBe(false);
    expect(isProjectAlreadyExists(null, "assistant-x")).toBe(false);
  });
});

describe("makeAdoptionFailureLimiter", () => {
  it("logs a stuck folder once per interval, with the failures in between", () => {
    const shouldLog = makeAdoptionFailureLimiter(1_000);
    expect(shouldLog("/a", 0)).toEqual({ log: true, failuresSinceLastLog: 1 });
    expect(shouldLog("/a", 100)).toEqual({ log: false });
    expect(shouldLog("/a", 200)).toEqual({ log: false });
    expect(shouldLog("/b", 300)).toEqual({ log: true, failuresSinceLastLog: 1 });
    expect(shouldLog("/a", 1_000)).toEqual({ log: true, failuresSinceLastLog: 3 });
    expect(shouldLog("/a", 1_500)).toEqual({ log: false });
  });
});
