import { describe, expect, it } from "vitest";

import { PERSONA_FACES } from "./assistantAvatar.logic";
import type { AssistantPlan } from "./assistantTemplates";
import {
  QUICK_ASSISTANT_ACCESS,
  quickCreateAssistant,
  type QuickCreateDeps,
} from "./quickCreateAssistant";

function fakeDeps(options: { readonly finishFails?: boolean } = {}) {
  const calls: Array<{ step: string; input: unknown }> = [];
  const deps: QuickCreateDeps = {
    createAssistant: async (input) => {
      calls.push({ step: "create", input });
      return { projectId: `assistant-${input.name.toLowerCase()}` };
    },
    createFromPlan: async (plan) => {
      calls.push({ step: "plan", input: plan });
      return { projectId: `assistant-${plan.name.toLowerCase()}` };
    },
    finish: async (projectId, input) => {
      calls.push({ step: "finish", input: { projectId, ...input } });
      if (options.finishFails) throw new Error("offline");
    },
    random: () => 0.5,
  };
  return { deps, calls };
}

describe("one-click assistant", () => {
  it("makes it at once: its own name, a persona face, Full on every project, set up", async () => {
    const { deps, calls } = fakeDeps();
    const made = await quickCreateAssistant(deps, {
      existing: [{ name: "Uno", emoji: null }],
    });
    expect(made.name).toBe("Ada");
    expect(made.projectId).toBe("assistant-ada");
    expect(PERSONA_FACES).toContain(made.emoji);
    expect(calls[0]).toEqual({
      step: "create",
      input: { name: "Ada", emoji: made.emoji, access: QUICK_ASSISTANT_ACCESS },
    });
    expect(QUICK_ASSISTANT_ACCESS).toEqual({ preset: "full", projects: "all" });
    expect(calls[1]).toMatchObject({
      step: "finish",
      input: { projectId: "assistant-ada", setup: "done" },
    });
  });

  it("never repeats a name on the team", async () => {
    const { deps } = fakeDeps();
    const made = await quickCreateAssistant(deps, {
      existing: [
        { name: "Uno", emoji: null },
        { name: "Ada", emoji: "🦊" },
      ],
    });
    expect(made.name).toBe("Scout");
  });

  it("a plan from Home's quiz writes who it is, with the one-click access", async () => {
    const { deps, calls } = fakeDeps();
    const plan = { name: "Ada", emoji: "🛠️", job: "Watch CI" } as unknown as AssistantPlan;
    const made = await quickCreateAssistant(deps, {
      existing: [{ name: "Ada", emoji: null }],
      plan,
    });
    expect(made.name).toBe("Ada 2");
    expect(calls[0]?.step).toBe("plan");
    expect(calls[0]?.input).toMatchObject({
      name: "Ada 2",
      job: "Watch CI",
      access: QUICK_ASSISTANT_ACCESS,
    });
  });

  it("is made even when its face's tone can't be saved yet", async () => {
    const { deps } = fakeDeps({ finishFails: true });
    await expect(quickCreateAssistant(deps, { existing: [] })).resolves.toMatchObject({
      projectId: "assistant-ada",
    });
  });
});
