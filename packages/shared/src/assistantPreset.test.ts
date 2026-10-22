import type { AssistantPreset, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_PRESETS,
  allowlistReaches,
  assistantPresetAllows,
  capAppLevel,
  capRuntimeToPreset,
  presetOfScopes,
  presetRuntimeCeiling,
  presetTokenAccess,
  type AssistantAction,
} from "./assistantPreset.ts";

const ACTIONS: ReadonlyArray<AssistantAction> = [
  "read-chats",
  "start-chat",
  "write-chat",
  "stop-chat",
  "answer-requests",
  "resolve-proposals",
  "remind",
  "change-things",
];

const allowedBy = (preset: AssistantPreset) =>
  ACTIONS.filter((action) => assistantPresetAllows(preset, action));

describe("assistantPresetAllows", () => {
  it("Full may do everything on the list", () => {
    expect(allowedBy("full")).toEqual(ACTIONS);
  });

  it("Helper works in chats but approves nothing", () => {
    expect(allowedBy("helper")).toEqual([
      "read-chats",
      "start-chat",
      "write-chat",
      "stop-chat",
      "remind",
      "change-things",
    ]);
  });

  it("Observer only reads (and reminds the person)", () => {
    expect(allowedBy("observer")).toEqual(["read-chats", "remind"]);
  });

  it("project keys: Full and Helper get their projects' keys, Observer never", () => {
    expect(assistantPresetAllows("full", "read-project-keys")).toBe(true);
    expect(assistantPresetAllows("helper", "read-project-keys")).toBe(true);
    expect(assistantPresetAllows("observer", "read-project-keys")).toBe(false);
  });

  it("each preset allows no more than the one above it", () => {
    for (const action of ACTIONS) {
      if (assistantPresetAllows("observer", action)) {
        expect(assistantPresetAllows("helper", action)).toBe(true);
      }
      if (assistantPresetAllows("helper", action)) {
        expect(assistantPresetAllows("full", action)).toBe(true);
      }
    }
  });
});

describe("runtime ceiling", () => {
  it("Full keeps the caller's mode; Helper and Observer cap at approval-required", () => {
    expect(presetRuntimeCeiling("full")).toBeNull();
    expect(capRuntimeToPreset("full-access", "full")).toBe("full-access");
    expect(capRuntimeToPreset("full-access", "helper")).toBe("approval-required");
    expect(capRuntimeToPreset("auto-accept-edits", "helper")).toBe("approval-required");
    expect(capRuntimeToPreset("approval-required", "helper")).toBe("approval-required");
    expect(capRuntimeToPreset("full-access", "observer")).toBe("approval-required");
  });
});

describe("connector cap", () => {
  it("Observer reads at most; the others keep what the person set", () => {
    expect(capAppLevel("write", "observer")).toBe("read");
    expect(capAppLevel("read", "observer")).toBe("read");
    expect(capAppLevel("none", "observer")).toBe("none");
    expect(capAppLevel("write", "helper")).toBe("write");
    expect(capAppLevel("none", "helper")).toBe("none");
    expect(capAppLevel("write", "full")).toBe("write");
  });
});

describe("token derivation", () => {
  const own = "assistant-scout";
  const picked = ["proj-a" as ProjectId];

  it("Full = today's assistant token (no behaviour change)", () => {
    expect(presetTokenAccess("full", "all", own)).toEqual({
      scopes: ["threads:read", "threads:write", "threads:approve"],
      projectAllowlist: "all",
      autoApprove: true,
    });
  });

  it("Helper writes without approve and keeps auto-start", () => {
    expect(presetTokenAccess("helper", picked, own)).toEqual({
      scopes: ["threads:read", "threads:write"],
      projectAllowlist: [own, "proj-a"],
      autoApprove: true,
    });
  });

  it("Observer reads only, nothing runs on its own", () => {
    expect(presetTokenAccess("observer", picked, own)).toEqual({
      scopes: ["threads:read"],
      projectAllowlist: [own, "proj-a"],
      autoApprove: false,
    });
  });

  it("the token reads back as the same preset", () => {
    for (const preset of ASSISTANT_PRESETS) {
      expect(presetOfScopes(presetTokenAccess(preset, "all", own).scopes)).toBe(preset);
    }
    // A Full token the technical page set to "ask first" is still Full.
    expect(presetOfScopes(["threads:read", "threads:write", "threads:approve"])).toBe("full");
    expect(presetOfScopes([])).toBe("observer");
  });

  it("the own workspace is always reachable, nothing else unless listed", () => {
    expect(allowlistReaches([], own, own)).toBe(true);
    expect(allowlistReaches(picked, "proj-a", own)).toBe(true);
    expect(allowlistReaches(picked, "proj-b", own)).toBe(false);
    expect(allowlistReaches("all", "proj-b", own)).toBe(true);
  });
});
