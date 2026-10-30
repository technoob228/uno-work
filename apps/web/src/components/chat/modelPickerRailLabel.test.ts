import { describe, expect, it } from "vitest";

import { modelPickerRailLabel } from "./ModelPickerSidebar";

describe("model picker rail labels", () => {
  it("names every agent under its icon (agent-flow pass 25.10: seven icons, no names)", () => {
    expect(
      ["Uno", "Uno Code", "Codex", "Claude", "Cursor", "OpenCode", "Uno Hermes"].map(
        modelPickerRailLabel,
      ),
    ).toEqual(["Uno", "Uno Code", "Codex", "Claude", "Cursor", "OpenCode", "Hermes"]);
  });

  it("long names keep their first word; custom ones stay whole for the rail to cut", () => {
    expect(modelPickerRailLabel("Claude Code")).toBe("Claude");
    expect(modelPickerRailLabel("Codex Personal")).toBe("Codex");
    expect(modelPickerRailLabel("My research agent")).toBe("My research agent");
    expect(modelPickerRailLabel("  Hermes ")).toBe("Hermes");
    expect(modelPickerRailLabel("Claude · Personal")).toBe("Personal");
  });
});
