import {
  AGENTS_PROFILE_END,
  AGENTS_PROFILE_START,
  instructionsVersion,
  joinAgentsProfile,
  planInstructions,
} from "@t3tools/shared/assistantInstructions";
import { describe, expect, it } from "vitest";

import { SHIPPED_ASSISTANT_INSTRUCTIONS } from "./assistantInstructionsHistory.ts";
import { ASSISTANT_INSTRUCTIONS_TEMPLATE } from "./Layers/AssistantService.ts";

const profile = `${AGENTS_PROFILE_START}\n## Who you are\n\nYour name is Ana.\n${AGENTS_PROFILE_END}`;

describe("AGENTS.md of assistants made by older versions", () => {
  it("the shipped template carries a version line and is not in the history", () => {
    expect(instructionsVersion(ASSISTANT_INSTRUCTIONS_TEMPLATE)).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(SHIPPED_ASSISTANT_INSTRUCTIONS).not.toContain(ASSISTANT_INSTRUCTIONS_TEMPLATE);
  });

  it("an untouched 0.0.104 file (writeFileIfMissing, no base) gets the new version", () => {
    for (const old of SHIPPED_ASSISTANT_INSTRUCTIONS) {
      const plan = planInstructions({
        current: joinAgentsProfile(old, profile),
        base: null,
        next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
        known: SHIPPED_ASSISTANT_INSTRUCTIONS,
      });
      expect(plan.state).toBe("current");
      expect(plan.write).toContain("PROPOSE a change");
      expect(plan.write).toContain("Your name is Ana.");
      expect(plan.base).toBe(ASSISTANT_INSTRUCTIONS_TEMPLATE);
    }
  });

  it("an edited 0.0.104 file is left alone and offered the update", () => {
    const edited = `${SHIPPED_ASSISTANT_INSTRUCTIONS[0]}\n- Always answer in Russian.\n`;
    const plan = planInstructions({
      current: edited,
      base: null,
      next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
      known: SHIPPED_ASSISTANT_INSTRUCTIONS,
    });
    expect(plan).toEqual({
      state: "update-available",
      write: null,
      base: SHIPPED_ASSISTANT_INSTRUCTIONS[0],
    });
  });
});
