import { describe, expect, it } from "vitest";

import {
  personLabel,
  rotateLine,
  teamErrorCode,
  teamErrorMessage,
  teamProjectOf,
  toggledKeys,
} from "./projectTeam.logic";

const owner = { user_id: 85, email: "a@b.c", username: "misha" };

describe("project team words", () => {
  it("calls people by the name they chose", () => {
    expect(personLabel({ email: "a@b.c", username: "anya" })).toBe("anya");
    expect(personLabel({ email: "a@b.c", username: "uno_1058" })).toBe("a@b.c");
    expect(personLabel({ email: null, username: "uno_1058" })).toBe("uno_1058");
  });

  it("turns console codes into plain lines, and never shows a raw answer", () => {
    expect(teamErrorCode({ body: { error: "TEAM_LIMIT" } })).toBe("TEAM_LIMIT");
    expect(teamErrorCode(new Error("x"))).toBeNull();
    expect(teamErrorCode(null)).toBeNull();
    expect(teamErrorMessage({ body: { error: "ALREADY_MEMBER" } })).toContain("already");
    expect(teamErrorMessage({ body: { error: "SOMETHING_NEW" } })).toBe(
      "That didn't work. Try again in a moment.",
    );
  });

  it("finds the team of a synced project", () => {
    const list = {
      projects: [{ id: 12, name: "notes", role: "owner" as const, owner }],
      invites: [],
    };
    expect(teamProjectOf(list, "notes")?.id).toBe(12);
    expect(teamProjectOf(list, "other")).toBeNull();
    expect(teamProjectOf(null, "notes")).toBeNull();
  });

  it("sends the whole set of keys", () => {
    expect(toggledKeys(["B"], "A", true)).toEqual(["A", "B"]);
    expect(toggledKeys(["A", "B"], "A", false)).toEqual(["B"]);
    expect(toggledKeys(["A"], "A", true)).toEqual(["A"]);
  });

  it("says which keys to change after someone leaves", () => {
    expect(rotateLine("anya", ["STRIPE_KEY"])).toBe(
      "anya no longer has access, but the key they had stays on their computers. Change STRIPE_KEY.",
    );
    expect(rotateLine("anya", ["A", "B"])).toContain("Change these: A, B.");
  });
});
