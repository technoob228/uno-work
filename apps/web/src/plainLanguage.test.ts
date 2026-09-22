import { describe, expect, it } from "vitest";

import {
  CHAT_WORKSPACE_MODE_EXPLANATIONS,
  CHAT_WORKSPACE_MODE_LABELS,
  MACHINE_KIND_LABELS,
  MACHINE_STATUS_LABELS,
  PERMISSION_MODES,
  PERMISSION_MODE_ORDER,
  PLAIN_TERMS,
  PLAIN_TERM_KEYS,
  permissionModeConsequence,
  permissionModeLabel,
  plainExplanation,
  plainLabel,
  plainLabelWithTechnical,
  plainPlural,
} from "./plainLanguage";

const isOneLine = (text: string) => !text.includes("\n");
const endsLikeASentence = (text: string) => /[.!?]$/u.test(text);

describe("PLAIN_TERMS", () => {
  it("covers every concept the product requirement names", () => {
    expect(PLAIN_TERM_KEYS).toEqual(
      expect.arrayContaining([
        "machine",
        "project",
        "chat",
        "step",
        "agent",
        "model",
        "permissions",
        "instructions",
        "projectFolder",
        "snapshot",
        "myMachines",
        "agentSetup",
      ]),
    );
  });

  it.each(PLAIN_TERM_KEYS)("%s has a label, a plural and a one-line explanation", (term) => {
    const entry = PLAIN_TERMS[term];
    expect(entry.label.trim().length).toBeGreaterThan(0);
    expect(entry.plural.trim().length).toBeGreaterThan(0);
    expect(entry.explanation.trim().length).toBeGreaterThan(0);
    expect(isOneLine(entry.explanation)).toBe(true);
    expect(endsLikeASentence(entry.explanation)).toBe(true);
    // Labels are what a person reads in a button or a heading: short, no jargon punctuation.
    expect(entry.label.length).toBeLessThanOrEqual(20);
    expect(entry.label).not.toMatch(/[_/\\]/u);
  });

  it("uses the founder's wording for the renamed concepts", () => {
    expect(plainLabel("machine")).toBe("Machine");
    expect(plainExplanation("machine")).toBe("Where your files and agents actually run.");
    expect(plainLabel("chat")).toBe("Chat");
    expect(plainLabel("step")).toBe("Step");
    expect(plainLabel("agent")).toBe("Agent");
    expect(plainLabel("instructions")).toBe("Instructions");
    expect(plainExplanation("instructions")).toBe(
      "A note the agent reads before every task in this project.",
    );
    expect(plainLabel("projectFolder")).toBe("Project folder");
    expect(plainExplanation("projectFolder")).toBe("The agent's workspace on this machine.");
    expect(plainLabel("snapshot")).toBe("Snapshot");
    expect(plainLabel("myMachines")).toBe("My machines");
    expect(plainLabel("agentSetup")).toBe("Agent setup");
  });

  it("renders the technical name in parentheses only for terms that have one", () => {
    expect(plainLabelWithTechnical("instructions")).toBe("Instructions (AGENTS.md)");
    expect(plainLabelWithTechnical("machine")).toBe("Machine (environment)");
    expect(plainLabelWithTechnical("project")).toBe("Project");
    expect(plainLabelWithTechnical("model")).toBe("Model");
  });

  it("pluralises the labels that get listed", () => {
    expect(plainPlural("machine")).toBe("Machines");
    expect(plainPlural("chat")).toBe("Chats");
    expect(plainPlural("agent")).toBe("Agents");
  });
});

describe("PERMISSION_MODES", () => {
  it("offers exactly the three runtime modes, in ask-first order", () => {
    expect(PERMISSION_MODE_ORDER).toEqual([
      "approval-required",
      "auto-accept-edits",
      "full-access",
    ]);
    expect(Object.keys(PERMISSION_MODES).toSorted()).toEqual([...PERMISSION_MODE_ORDER].toSorted());
  });

  it.each(PERMISSION_MODE_ORDER)("%s has a plain label and a one-line consequence", (mode) => {
    expect(permissionModeLabel(mode).trim().length).toBeGreaterThan(0);
    expect(isOneLine(permissionModeConsequence(mode))).toBe(true);
    expect(endsLikeASentence(permissionModeConsequence(mode))).toBe(true);
  });

  it("uses the agreed plain labels", () => {
    expect(permissionModeLabel("approval-required")).toBe("Ask before changes");
    expect(permissionModeLabel("auto-accept-edits")).toBe("Edit files freely");
    expect(permissionModeLabel("full-access")).toBe("Full access");
  });
});

describe("machine and chat-mode vocabularies", () => {
  it("names every machine kind and status", () => {
    // Labels follow what the machine is, never its role: the daemon serving
    // the page is not "This computer" when it is a box.
    expect(MACHINE_KIND_LABELS).toEqual({
      uno_box: "Cloud computer",
      computer: "Your computer",
      server: "Other machine",
    });
    for (const label of Object.values(MACHINE_KIND_LABELS)) {
      expect(label).not.toMatch(/this computer/iu);
    }
    expect(Object.keys(MACHINE_STATUS_LABELS).toSorted()).toEqual([
      "offline",
      "online",
      "sleeping",
      "unknown",
    ]);
    for (const label of Object.values(MACHINE_STATUS_LABELS)) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  it("explains both places a chat can work", () => {
    for (const mode of ["local", "worktree"] as const) {
      expect(CHAT_WORKSPACE_MODE_LABELS[mode].trim().length).toBeGreaterThan(0);
      expect(isOneLine(CHAT_WORKSPACE_MODE_EXPLANATIONS[mode])).toBe(true);
    }
    expect(CHAT_WORKSPACE_MODE_EXPLANATIONS.worktree).toContain("git worktree");
  });
});
