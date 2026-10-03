import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_SETUP_PROGRESS } from "../setup/setupModel";
import { buildPlan, fallbackDraft, findTemplate } from "./assistantTemplates";
import {
  createAssistant,
  createLocalAssistant,
  type CreateAssistantDeps,
  type LocalCreateDeps,
} from "./createAssistant";

const ENV = "env-assistant" as EnvironmentId;
const template = findTemplate("marketing")!;
const plan = buildPlan({
  phrase: template.phrase,
  template,
  draft: fallbackDraft(template.phrase, template),
  answers: [
    { questionId: "how_often", question: "How often?", answer: "Every Monday", cron: "0 10 * * 1" },
  ],
});

function deps(overrides: Partial<CreateAssistantDeps> = {}) {
  const files: Record<string, string> = { "AGENTS.md": "# Instructions\n" };
  const base: CreateAssistantDeps = {
    createComputer: vi.fn(async () => ({ boxId: 42, environmentId: ENV })),
    getPermissions: vi.fn(async () => ({
      supported: true as const,
      restricted: true,
      permissions: plan.connectors,
    })),
    putPermissions: vi.fn(async () => true),
    ensureAssistant: vi.fn(async () => true),
    readFile: vi.fn(async (_env, name) => files[name] ?? ""),
    writeFile: vi.fn(async (_env, name, content) => {
      files[name] = content;
    }),
    readSetup: () => EMPTY_SETUP_PROGRESS,
    saveSetup: vi.fn(async () => undefined),
    createSchedule: vi.fn(async () => undefined),
    now: () => "2026-10-02T10:00:00Z",
    ...overrides,
  };
  return { deps: base, files };
}

describe("createAssistant", () => {
  it("leaves the console's template permissions alone and writes the assistant", async () => {
    const { deps: d, files } = deps();
    const result = await createAssistant(plan, d);
    expect(d.putPermissions).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      boxId: 42,
      accessEnforced: true,
      assistantReady: true,
      scheduleCreated: true,
      notes: [],
    });
    expect(files["SOUL.md"]).toContain("I am Ana");
    expect(files["AGENTS.md"]).toContain("Your name is Ana.");
    expect(files["AGENTS.md"]).toContain("Read SOUL.md");
    expect(d.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ boxId: 42, cron: "0 10 * * 1" }),
    );
    expect(d.saveSetup).toHaveBeenCalledWith(
      ENV,
      expect.objectContaining({
        finished: true,
        answers: expect.objectContaining({ assistant_name: "Ana", assistant_box_id: "42" }),
      }),
    );
  });

  it("sends the whole set when the person changed a level on the card", async () => {
    const changed = { ...plan, connectors: { ...plan.connectors, github: "read" as const } };
    const { deps: d } = deps();
    await createAssistant(changed, d);
    expect(d.putPermissions).toHaveBeenCalledWith(42, changed.connectors);
  });

  it("says so when access can't be limited, and keeps going", async () => {
    const { deps: d } = deps({
      getPermissions: vi.fn(async () => ({ supported: false as const })),
    });
    const result = await createAssistant(plan, d);
    expect(result.accessEnforced).toBe(false);
    expect(result.notes[0]).toContain("reaches every app you connected");
    expect(result.assistantReady).toBe(true);
  });

  it("folds SOUL/USER into AGENTS.md on a daemon that refuses the new files", async () => {
    const { deps: d, files } = deps({
      writeFile: vi.fn(async (_env, name, content) => {
        if (name === "SOUL.md" || name === "USER.md") throw new Error("400");
        files[name] = content;
      }),
    });
    await createAssistant(plan, d);
    expect(files["AGENTS.md"]).toContain("# Who I am");
    expect(files["AGENTS.md"]).toContain("# About the person");
  });

  it("hands over a computer that is still starting", async () => {
    const { deps: d } = deps({
      createComputer: vi.fn(async () => ({ boxId: 7, environmentId: null })),
    });
    const result = await createAssistant(plan, d);
    expect(result).toMatchObject({ boxId: 7, assistantReady: false });
    expect(d.ensureAssistant).not.toHaveBeenCalled();
    expect(result.notes.some((note) => note.includes("Finish setup"))).toBe(true);
  });
});

describe("createLocalAssistant (on this computer, the default)", () => {
  function localDeps(overrides: Partial<LocalCreateDeps> = {}) {
    const files: Record<string, string> = { "AGENTS.md": "# Instructions\n" };
    const base: LocalCreateDeps = {
      createAssistant: vi.fn(async () => ({
        projectId: "assistant-ana",
        workspaceRoot: "/home/unowork/UnoWork/Assistants/ana",
      })),
      readFile: vi.fn(async (_id, name) => files[name] ?? ""),
      writeFile: vi.fn(async (_id, name, content) => {
        files[name] = content;
      }),
      putApps: vi.fn(async () => undefined),
      createSchedule: vi.fn(async () => undefined),
      now: () => "2026-10-02T10:00:00Z",
      ...overrides,
    };
    return { deps: base, files };
  }

  it("makes its folder, writes who it is, sets its apps here and its schedule for its folder", async () => {
    const { deps: d, files } = localDeps();
    const result = await createLocalAssistant(plan, d);
    expect(result).toEqual({
      projectId: "assistant-ana",
      accessSet: true,
      scheduleCreated: true,
      notes: [],
    });
    expect(d.createAssistant).toHaveBeenCalledWith({
      name: "Ana",
      emoji: plan.emoji,
      template: "marketing",
    });
    expect(files["SOUL.md"]).toContain("I am Ana");
    expect(files["AGENTS.md"]).toContain("Your name is Ana.");
    expect(d.putApps).toHaveBeenCalledWith("assistant-ana", plan.connectors);
    expect(d.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        cron: "0 10 * * 1",
        command: expect.stringContaining(
          "uno-work assistant-turn --workspace '/home/unowork/UnoWork/Assistants/ana' --prompt",
        ),
      }),
    );
  });

  it("explains instead of failing when this computer can't wake it or keep its apps", async () => {
    const { deps: d } = localDeps({
      createSchedule: null,
      putApps: vi.fn(async () => {
        throw new Error("older daemon");
      }),
    });
    const result = await createLocalAssistant(plan, d);
    expect(result.accessSet).toBe(false);
    expect(result.scheduleCreated).toBe(false);
    expect(result.notes).toHaveLength(2);
    expect(result.notes[1]).toContain("can't wake Ana on a schedule");
  });
});
