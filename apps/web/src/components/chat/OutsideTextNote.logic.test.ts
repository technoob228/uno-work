import { describe, expect, it } from "vitest";

import { outsideTextNoteLine, outsideTextSource } from "./OutsideTextNote.logic";

const user = (text: string) => ({ role: "user", text });

describe("the outside-text note", () => {
  it("names where the text came from", () => {
    const form = user(
      "What someone with the site's password typed into the form on report is below, between <outside_input_ab12> tags.",
    );
    const hook = user(
      "The body of the webhook request (application/json) is below, between <outside_input_cd34> tags.",
    );
    expect(outsideTextSource([form])).toBe("site form");
    expect(outsideTextSource([hook])).toBe("webhook");
    expect(outsideTextSource([form, hook])).toBe("both");
    expect(outsideTextNoteLine("site form")).toBe(
      "This chat read text from outside (a site form). Uno Work tools ask you first.",
    );
  });

  it("says just 'outside' when no message tells (a group member, an older chat)", () => {
    expect(outsideTextSource([user("Plain question about the form on report")])).toBeNull();
    // The agent quoting the words doesn't count: only the person's side carries the block.
    expect(
      outsideTextSource([
        { role: "assistant", text: "typed into the form on x <outside_input_1>" },
      ]),
    ).toBeNull();
    expect(outsideTextNoteLine(null)).toBe(
      "This chat read text from outside. Uno Work tools ask you first.",
    );
  });
});
