import { describe, expect, it } from "vitest";

import {
  GALLERY_CHARACTERS,
  MIDDLE_SLIDERS,
  characterLine,
  defaultMachine,
  machineUnavailableReason,
  personaOfFace,
  sameNameNote,
} from "./assistantGallery.logic";

describe("characterLine", () => {
  it("puts slider words first, then tags, once each, capital first letter only", () => {
    expect(characterLine({ chatty: 10, bold: 50, playful: 90 }, ["Warm", "Careful", "Brief"])).toBe(
      "Brief, playful, warm, careful",
    );
  });

  it("is empty with middle sliders and no tags", () => {
    expect(characterLine(MIDDLE_SLIDERS, [])).toBe("");
  });

  it("gives Mia her line", () => {
    const mia = GALLERY_CHARACTERS.find((one) => one.id === "mia")!;
    expect(characterLine(mia.sliders, mia.tags)).toBe("Brief, warm, careful");
  });
});

describe("sameNameNote", () => {
  const existing = [
    { name: "Mia", environmentId: "mac", computerLabel: "MacBook", revoked: false },
    { name: "Leo", environmentId: "cloud", computerLabel: "uno-work", revoked: true },
  ];

  it("names both computers when the twin is on another one", () => {
    const note = sameNameNote({
      name: " mia ",
      environmentId: "cloud",
      thisLabel: "uno-work",
      existing,
    });
    expect(note).toEqual({
      kind: "other-computer",
      text: "There's a mia on MacBook too. They'll show as mia · uno-work and mia · MacBook.",
    });
  });

  it("asks for another name on the same computer", () => {
    const note = sameNameNote({
      name: "MIA",
      environmentId: "mac",
      thisLabel: "MacBook",
      existing,
    });
    expect(note.kind).toBe("same-computer");
  });

  it("ignores revoked ones and empty names", () => {
    expect(
      sameNameNote({ name: "Leo", environmentId: "cloud", thisLabel: "x", existing }).kind,
    ).toBe("none");
    expect(sameNameNote({ name: "  ", environmentId: "mac", thisLabel: "x", existing }).kind).toBe(
      "none",
    );
  });
});

describe("machines", () => {
  const rows = [
    { environmentId: "free", status: "sleeping", kind: "uno_box" },
    { environmentId: "mac", status: "offline", kind: "computer" },
    { environmentId: "cloud", status: "online", kind: "uno_box" },
  ];

  it("explains why a computer can't take one", () => {
    expect(machineUnavailableReason(rows[0]!)).toBe(
      "asleep — Free computers sleep. Plus keeps it on",
    );
    expect(machineUnavailableReason(rows[1]!)).toBe("asleep — the laptop is closed");
    expect(machineUnavailableReason(rows[2]!)).toBeNull();
  });

  it("falls back to the first awake computer", () => {
    expect(defaultMachine(rows, ["free", "mac"])).toBe("cloud");
    expect(defaultMachine(rows, [undefined, "cloud"])).toBe("cloud");
    expect(defaultMachine(rows.slice(0, 2), ["mac"])).toBeNull();
  });
});

describe("personaOfFace", () => {
  it("maps faces to portrait kinds", () => {
    expect(personaOfFace("🤖")).toBe("robot");
    expect(personaOfFace("👽")).toBe("alien");
    expect(personaOfFace("🦉")).toBe("animal");
    expect(personaOfFace("🧑‍🚀")).toBe("human");
  });
});
