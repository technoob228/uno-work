import { describe, expect, it } from "vitest";

import {
  ASSISTANT_MOVE_BUNDLE_VERSION,
  type AssistantMoveBundle,
  type AssistantMoveDeps,
  AssistantMoveError,
  describeAssistantMove,
  runAssistantMove,
  splitMovableAutomations,
  TELEGRAM_POLL_HANDOVER_MS,
} from "./assistantMove";

const bundle = (overrides: Partial<AssistantMoveBundle> = {}): AssistantMoveBundle => ({
  version: ASSISTANT_MOVE_BUNDLE_VERSION,
  projectId: "assistant-home",
  title: "Uno",
  isUno: true,
  exportedAt: "2026-11-10T21:00:00.000Z",
  defaultModelSelection: null,
  workspace: [],
  state: [],
  skipped: [],
  connectors: [],
  reminders: [],
  historyChats: 3,
  ...overrides,
});

const from = { name: "kinship", boxId: 3273 };
const to = { name: "stage-work", boxId: 2531 };
const input = { projectId: "assistant-home", name: "Uno", from, to };

function fakeDeps(
  options: {
    readonly bundle?: AssistantMoveBundle;
    readonly fail?: Partial<Record<string, string>>;
    readonly importOk?: boolean;
    readonly automations?: number;
  } = {},
) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const failing = (name: string) => {
    calls.push(name);
    const message = options.fail?.[name];
    if (message !== undefined) throw new Error(message);
  };
  const deps: AssistantMoveDeps = {
    source: {
      exportBundle: async () => {
        failing("export");
        return options.bundle ?? bundle();
      },
      release: async () => failing("release"),
      unrelease: async () => failing("unrelease"),
      listAutomations: async () => ({
        move: Array.from({ length: options.automations ?? 0 }, (_, index) => ({
          id: index + 1,
          name: `daily ${index + 1}`,
          input: { instruction: "x" },
        })),
        stay: [],
      }),
      deleteAutomation: async (id) => failing(`source-delete-automation:${id}`),
    },
    target: {
      importBundle: async () => {
        failing("import");
        return {
          projectId: "assistant-home",
          ok: options.importOk ?? true,
          problems: options.importOk === false ? ["its instructions (AGENTS.md) are missing"] : [],
        };
      },
      activate: async () => {
        failing("activate");
        return { relink: [] };
      },
      discard: async () => failing("discard"),
      createAutomation: async () => {
        failing("create-automation");
        return { id: 100 + calls.filter((call) => call === "create-automation").length };
      },
      deleteAutomation: async (id) => failing(`target-delete-automation:${id}`),
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { deps, calls, sleeps };
}

describe("runAssistantMove", () => {
  it("copies, checks, then lets go on the source before the target answers", async () => {
    const { deps, calls } = fakeDeps({ automations: 1 });
    const steps: string[] = [];
    const outcome = await runAssistantMove(input, deps, (step) => steps.push(step));
    expect(calls).toEqual([
      "export",
      "import",
      "create-automation",
      "release",
      "activate",
      "source-delete-automation:1",
    ]);
    expect(steps).toEqual(["copy", "check", "switch", "done"]);
    expect(outcome.automationsMoved).toBe(1);
    expect(outcome.historyChats).toBe(3);
  });

  it("waits out the source's Telegram poll only when its own bot moves", async () => {
    const own = fakeDeps({
      bundle: bundle({ connectors: [{ kind: "telegram", config: {}, via: "own" }] }),
    });
    await runAssistantMove(input, own.deps);
    expect(own.sleeps).toEqual([TELEGRAM_POLL_HANDOVER_MS]);
    const relay = fakeDeps({
      bundle: bundle({ connectors: [{ kind: "telegram", config: {}, via: "relay" }] }),
    });
    await runAssistantMove(input, relay.deps);
    expect(relay.sleeps).toEqual([]);
  });

  it("a target that didn't come up is discarded; the source is never touched", async () => {
    const { deps, calls } = fakeDeps({ importOk: false });
    const error = await runAssistantMove(input, deps).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AssistantMoveError);
    expect((error as AssistantMoveError).changed).toBe(false);
    expect((error as AssistantMoveError).message).toContain("AGENTS.md");
    expect(calls).toEqual(["export", "import", "discard"]);
  });

  it("an import that throws is discarded too", async () => {
    const { deps, calls } = fakeDeps({ fail: { import: "disk full" } });
    await expect(runAssistantMove(input, deps)).rejects.toThrow(/disk full.*Nothing changed/);
    expect(calls).toEqual(["export", "import", "discard"]);
  });

  it("an automation that can't be made there undoes the copy", async () => {
    const { deps, calls } = fakeDeps({ automations: 2, fail: { "create-automation": "quota" } });
    await expect(runAssistantMove(input, deps)).rejects.toThrow(/daily 1.*quota/);
    expect(calls).toEqual(["export", "import", "create-automation", "discard"]);
    expect(calls).not.toContain("release");
  });

  it("a target without automations refuses before anything moves", async () => {
    const { deps, calls } = fakeDeps({ automations: 1 });
    const noAutomations: AssistantMoveDeps = {
      ...deps,
      target: { ...deps.target, createAutomation: undefined },
    } as AssistantMoveDeps;
    await expect(runAssistantMove(input, noAutomations)).rejects.toThrow(/need a cloud computer/);
    expect(calls).toEqual(["export", "import", "discard"]);
  });

  it("a failed switch gives the source its channels back and removes the copy", async () => {
    const { deps, calls } = fakeDeps({ automations: 1, fail: { activate: "bot refused" } });
    const error = (await runAssistantMove(input, deps).catch(
      (cause: unknown) => cause,
    )) as AssistantMoveError;
    expect(error.step).toBe("switch");
    expect(error.changed).toBe(false);
    expect(error.message).toContain("stays on kinship");
    expect(calls).toEqual([
      "export",
      "import",
      "create-automation",
      "release",
      "activate",
      "unrelease",
      "target-delete-automation:101",
      "discard",
    ]);
  });

  it("says so when the source can't take it back", async () => {
    const { deps } = fakeDeps({ fail: { activate: "x", unrelease: "offline" } });
    const error = (await runAssistantMove(input, deps).catch(
      (cause: unknown) => cause,
    )) as AssistantMoveError;
    expect(error.changed).toBe(true);
    expect(error.message).toContain("Undo");
  });

  it("an unreachable source changes nothing anywhere", async () => {
    const { deps, calls } = fakeDeps({ fail: { export: "No connection" } });
    await expect(runAssistantMove(input, deps)).rejects.toThrow(/Couldn't read Uno on kinship/);
    expect(calls).toEqual(["export"]);
  });

  it("refuses a move to where it already is", async () => {
    const { deps, calls } = fakeDeps();
    await expect(runAssistantMove({ ...input, to: from }, deps)).rejects.toThrow(/already lives/);
    expect(calls).toEqual([]);
  });
});

describe("splitMovableAutomations", () => {
  const automation = (
    id: number,
    trigger: string,
    executor?: string,
    assistant = "assistant-home",
  ) => ({
    id,
    assistant,
    name: `a${id}`,
    instruction: "do it",
    enabled: true,
    trigger: { kind: trigger },
    ...(executor !== undefined ? { executor: { kind: executor } } : {}),
  });

  it("moves its schedules and events, keeps web addresses and chats where they are", () => {
    const split = splitMovableAutomations(
      [
        automation(1, "schedule"),
        automation(2, "webhook"),
        automation(3, "schedule", "chat"),
        automation(4, "schedule", "assistant"),
        automation(5, "schedule", undefined, "assistant-mia"),
      ],
      "assistant-home",
    );
    expect(split.move.map((entry) => entry.id)).toEqual([1, 4]);
    expect(split.stay).toEqual(["a2", "a3"]);
    expect(split.move[0]!.input).toMatchObject({
      assistant: "assistant-home",
      instruction: "do it",
    });
  });
});

describe("describeAssistantMove", () => {
  it("names what came along and what to do", () => {
    const line = describeAssistantMove(
      {
        projectId: "assistant-home",
        relink: ["telegram"],
        automationsMoved: 2,
        historyChats: 4,
        skipped: [],
        warnings: [],
      },
      { name: "Uno", from: "kinship", to: "stage-work" },
    );
    expect(line).toContain("2 automations");
    expect(line).toContain("history/");
    expect(line).toContain("Connect Telegram again on stage-work");
  });
});
