import type { AssistantPreset, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  ASKS_FIRST_CATEGORIES,
  ASKS_FIRST_CATEGORY_LABEL,
  ASSISTANT_MODE_COPY,
  ASSISTANT_MODES,
  ASSISTANT_PRESETS,
  assistantModeOf,
  asksFirstCategory,
  presetAsksFirst,
  presetForMode,
  allowlistReaches,
  assistantPresetAllows,
  capAppLevel,
  assistantOwnRuntimeMode,
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
  it("Full keeps the caller's mode; Helper edits freely but asks before commands; Observer asks", () => {
    expect(presetRuntimeCeiling("full")).toBeNull();
    expect(capRuntimeToPreset("full-access", "full")).toBe("full-access");
    expect(capRuntimeToPreset("full-access", "helper")).toBe("auto-accept-edits");
    expect(capRuntimeToPreset("auto-accept-edits", "helper")).toBe("auto-accept-edits");
    expect(capRuntimeToPreset("approval-required", "helper")).toBe("approval-required");
    expect(capRuntimeToPreset("full-access", "observer")).toBe("approval-required");
  });

  it("an assistant's own chats run at its ceiling: Autonomous = full, Cautious = edits only", () => {
    expect(assistantOwnRuntimeMode("full")).toBe("full-access");
    expect(assistantOwnRuntimeMode("helper")).toBe("auto-accept-edits");
    expect(assistantOwnRuntimeMode("observer")).toBe("approval-required");
  });
});

describe("two modes (Misha 23.10)", () => {
  it("Full is 'Autonomous'; Helper and Observer are 'Cautious'", () => {
    expect(assistantModeOf("full")).toBe("itself");
    expect(assistantModeOf("helper")).toBe("asks-first");
    expect(assistantModeOf("observer")).toBe("asks-first");
    expect(ASSISTANT_MODES).toEqual(["itself", "asks-first"]);
  });

  it("a mode maps back to a preset; an old Observer stays read-only under 'Cautious'", () => {
    expect(presetForMode("itself", "observer")).toBe("full");
    expect(presetForMode("asks-first", "full")).toBe("helper");
    expect(presetForMode("asks-first", "helper")).toBe("helper");
    expect(presetForMode("asks-first", "observer")).toBe("observer");
  });

  it("only 'Autonomous' acts outward without the person's Allow", () => {
    expect(presetAsksFirst("full")).toBe(false);
    expect(presetAsksFirst("helper")).toBe(true);
    expect(presetAsksFirst("observer")).toBe(true);
  });

  it("names exactly the outward-acting tools, by category", () => {
    expect(asksFirstCategory("mail_send", {})).toBe("email");
    expect(asksFirstCategory("site_publish", {})).toBe("sites");
    expect(asksFirstCategory("site_unpublish", {})).toBe("sites");
    expect(asksFirstCategory("app_deploy", {})).toBe("internet");
    expect(asksFirstCategory("app_show_on_internet", {})).toBe("internet");
    expect(asksFirstCategory("spark_deploy", {})).toBe("internet");
    expect(asksFirstCategory("file_share_link", {})).toBe("share");
    expect(asksFirstCategory("drive_share_link", {})).toBe("share");
    expect(asksFirstCategory("app_remove", {})).toBe("delete");
    expect(asksFirstCategory("spark_delete", {})).toBe("delete");
    expect(asksFirstCategory("db_create", {})).toBe("create");
    expect(asksFirstCategory("computer_create", {})).toBe("create");
    expect(asksFirstCategory("assistant_create", {})).toBe("create");
    // Cleanup deletes only when it applies.
    expect(asksFirstCategory("computer_cleanup", { apply: true })).toBe("delete");
    expect(asksFirstCategory("computer_cleanup", {})).toBeNull();
    // Working on its own things runs.
    for (const tool of ["files_list", "app_start", "chat_create", "notify", "mail_read"]) {
      expect(asksFirstCategory(tool, {})).toBeNull();
    }
  });

  it("the 'Cautious' copy lists every category the daemon checks, and no payments", () => {
    const details = ASSISTANT_MODE_COPY["asks-first"].details.join(" ");
    for (const category of ASKS_FIRST_CATEGORIES) {
      expect(details).toContain(ASKS_FIRST_CATEGORY_LABEL[category]);
    }
    const all = Object.values(ASSISTANT_MODE_COPY)
      .map((copy) => `${copy.line} ${copy.details.join(" ")}`)
      .join(" ")
      .toLowerCase();
    expect(all).not.toContain("payment");
    expect(all).not.toContain("money");
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
