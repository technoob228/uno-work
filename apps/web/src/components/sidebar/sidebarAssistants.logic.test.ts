import { describe, expect, it } from "vitest";

import { assistantsHeaderState } from "./sidebarAssistants.logic";

describe("sidebar assistants header", () => {
  it('"+" is always there with the team, whatever the team size', () => {
    expect(assistantsHeaderState({ teamShown: true })).toEqual({
      showHeader: true,
      showCreate: true,
    });
  });

  it("without the team on the account: Uno alone, no header, no '+'", () => {
    expect(assistantsHeaderState({ teamShown: false })).toEqual({
      showHeader: false,
      showCreate: false,
    });
  });
});
