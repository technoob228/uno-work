import { describe, expect, it } from "vitest";

import { ASSISTANT_PROJECT_ID_PREFIX, EnvironmentId, ProjectId } from "@t3tools/contracts";

import { FIRST_CHAT_SUGGESTIONS, pickFirstChatProject } from "./firstChat";

const env = (value: string) => EnvironmentId.make(value);
const project = (id: string, environmentId: string) => ({
  id: ProjectId.make(id),
  environmentId: env(environmentId),
});

describe("pickFirstChatProject", () => {
  it("returns null when the machine has no projects", () => {
    expect(pickFirstChatProject([], env("env-1"))).toBeNull();
  });

  it("picks the first project on the connected machine", () => {
    const first = project("proj-1", "env-1");
    const second = project("proj-2", "env-1");
    expect(pickFirstChatProject([first, second], env("env-1"))).toBe(first);
  });

  it("ignores projects on other machines", () => {
    const elsewhere = project("proj-1", "env-2");
    expect(pickFirstChatProject([elsewhere], env("env-1"))).toBeNull();
  });

  it("never lands the first chat in the assistant's home project", () => {
    const assistant = project(`${ASSISTANT_PROJECT_ID_PREFIX}home`, "env-1");
    const real = project("proj-2", "env-1");
    expect(pickFirstChatProject([assistant, real], env("env-1"))).toBe(real);
    expect(pickFirstChatProject([assistant], env("env-1"))).toBeNull();
  });
});

describe("FIRST_CHAT_SUGGESTIONS", () => {
  it("offers distinct, non-empty suggestions", () => {
    expect(FIRST_CHAT_SUGGESTIONS.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(FIRST_CHAT_SUGGESTIONS.map((suggestion) => suggestion.id));
    expect(ids.size).toBe(FIRST_CHAT_SUGGESTIONS.length);
    for (const suggestion of FIRST_CHAT_SUGGESTIONS) {
      expect(suggestion.label.trim().length).toBeGreaterThan(0);
      expect(suggestion.prompt.trim().length).toBeGreaterThan(0);
    }
  });
});
