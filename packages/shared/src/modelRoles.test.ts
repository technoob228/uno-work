import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { RoutingRule } from "./assistantMemory.ts";
import {
  detectPlanSources,
  planAutoRoles,
  quickModel,
  sameSelection,
  simpleTaskRule,
  suggestRoles,
  withSimpleTask,
} from "./modelRoles.ts";

interface ModelSpec {
  readonly slug: string;
  readonly name?: string | undefined;
  readonly isDefault?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

const provider = (
  driver: string,
  models: ReadonlyArray<ModelSpec>,
  patch: Partial<Record<string, unknown>> = {},
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(driver),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-14T00:00:00.000Z",
    models: models.map((model) => ({
      slug: model.slug,
      name: model.name ?? model.slug,
      isCustom: false,
      capabilities: model.metadata ? { metadata: model.metadata } : null,
      ...(model.isDefault ? { isDefault: true } : {}),
    })),
    slashCommands: [],
    skills: [],
    ...patch,
  }) as unknown as ServerProvider;

// What the CLIs list on 14.11: Claude Code recommends Opus 5.5 next to Fable 5.2.
const claude = provider(
  "claudeAgent",
  [
    { slug: "claude-fable-5-2", name: "Fable 5.2" },
    { slug: "claude-opus-5-5", name: "Opus 5.5", isDefault: true },
    { slug: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    { slug: "claude-haiku-4-5", name: "Haiku 4.5" },
  ],
  { auth: { status: "authenticated", type: "claude.ai" } },
);
const codex = provider(
  "codex",
  [
    { slug: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { slug: "gpt-5.6-terra", name: "GPT-5.6 Terra", isDefault: true },
    { slug: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  ],
  { auth: { status: "authenticated", type: "chatgpt" } },
);
const uno = provider("uno", [
  { slug: "uno/uno/smart", name: "Smart", metadata: { unoGroup: "included", tier: "strong" } },
  { slug: "uno/uno/fast", name: "Fast", metadata: { unoGroup: "included", tier: "cheap" } },
  {
    slug: "uno/anthropic/claude-opus-5.5",
    name: "Claude Opus 5.5",
    metadata: { unoGroup: "premium", tier: "frontier" },
  },
]);
const ready = () => true;
const sel = (instanceId: string, model: string) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});

describe("suggestRoles: a set by the plans connected here", () => {
  it("only Uno AI: Smart for complex work, Fast for simple tasks and replies", () => {
    const roles = suggestRoles({ providers: [uno], isReady: ready, unoReplies: true });
    expect(roles.complex).toEqual(sel("uno", "uno/uno/smart"));
    expect(roles.simple).toEqual(sel("uno", "uno/uno/fast"));
    expect(roles.replies).toEqual({ provider: "uno", model: "uno/fast" });
    expect(roles.sources).toEqual(["uno"]);
    expect(roles.why).toMatch(/^Only Uno AI here/);
  });

  it("only Claude: what Claude Code recommends, its quick model for simple tasks", () => {
    const roles = suggestRoles({ providers: [claude, uno], isReady: ready, unoReplies: true });
    expect(roles.complex).toEqual(sel("claudeAgent", "claude-opus-5-5"));
    expect(roles.simple).toEqual(sel("claudeAgent", "claude-haiku-4-5"));
    expect(roles.replies?.model).toBe("uno/fast");
    expect(roles.why).toContain("Your Claude plan here: complex work on Opus 5.5");
  });

  it("the CLI recommends Fable 5.2: Fable, not a list in Uno Work", () => {
    const fableFirst = provider(
      "claudeAgent",
      [
        { slug: "claude-fable-5-2", name: "Fable 5.2", isDefault: true },
        { slug: "claude-opus-5-5", name: "Opus 5.5" },
      ],
      { auth: { status: "authenticated", type: "claude.ai" } },
    );
    expect(
      suggestRoles({ providers: [fableFirst], isReady: ready, unoReplies: false }).complex,
    ).toEqual(sel("claudeAgent", "claude-fable-5-2"));
  });

  it("only Codex: Codex's recommended model, Luna for simple tasks", () => {
    const roles = suggestRoles({ providers: [codex, uno], isReady: ready, unoReplies: true });
    expect(roles.complex).toEqual(sel("codex", "gpt-5.6-terra"));
    expect(roles.simple).toEqual(sel("codex", "gpt-5.6-luna"));
    expect(roles.why).toContain("Your ChatGPT plan here");
  });

  it("Claude + Codex + Uno: Opus through Claude Code, Luna through Codex, Uno Fast replies", () => {
    const roles = suggestRoles({
      providers: [uno, codex, claude],
      isReady: ready,
      unoReplies: true,
    });
    expect(roles.complex).toEqual(sel("claudeAgent", "claude-opus-5-5"));
    expect(roles.simple).toEqual(sel("codex", "gpt-5.6-luna"));
    expect(roles.replies).toEqual({ provider: "uno", model: "uno/fast" });
    expect(roles.sources).toEqual(["claude", "codex", "uno"]);
    expect(roles.why).toContain("save the Claude limit");
  });

  it("a plan that isn't ready here doesn't count", () => {
    const signedOut = provider("codex", codex.models, { auth: { status: "unknown" } });
    const roles = suggestRoles({ providers: [signedOut, uno], isReady: ready, unoReplies: true });
    expect(roles.complex).toEqual(sel("uno", "uno/uno/smart"));
    expect(detectPlanSources([signedOut], ready).codex).toBeNull();
    const onUnoCredits = provider("claudeAgent", claude.models, {
      auth: { status: "authenticated", type: "unoAi" },
    });
    expect(detectPlanSources([onUnoCredits], ready).claude).toBeNull();
  });

  it("no Uno AI key for the assistant: no reply model suggested", () => {
    const roles = suggestRoles({ providers: [claude], isReady: ready, unoReplies: false });
    expect(roles.replies).toBeNull();
    expect(roles.why).not.toContain("replies");
  });
});

describe("quickModel", () => {
  it("Uno Fast by the gateway's catalog, a small model of a CLI by its family", () => {
    expect(quickModel(uno)).toBe("uno/uno/fast");
    expect(quickModel(provider("uno", [{ slug: "uno/fast" }, { slug: "uno/smart" }]))).toBe(
      "uno/fast",
    );
    expect(quickModel(claude)).toBe("claude-haiku-4-5");
    expect(quickModel(codex)).toBe("gpt-5.6-luna");
    expect(quickModel(provider("claudeAgent", [{ slug: "claude-opus-5-5" }]))).toBeNull();
  });
});

describe("Simple tasks: the row of ROUTING.md", () => {
  const row = (taskType: string, source: RoutingRule["source"] = "default"): RoutingRule => ({
    taskType,
    harness: "claudeAgent",
    model: "claude-sonnet-5-5",
    effort: "medium",
    source,
    note: "",
  });

  it("the template's row becomes the person's, other rows stay", () => {
    const rules = [row("Anything with UI"), row("Simple tasks, small fixes")];
    expect(simpleTaskRule(rules)?.taskType).toBe("Simple tasks, small fixes");
    const next = withSimpleTask(rules, sel("codex", "gpt-5.6-luna"));
    expect(next[0]).toEqual(rules[0]);
    expect(next[1]).toMatchObject({
      taskType: "Simple tasks, small fixes",
      harness: "codex",
      model: "gpt-5.6-luna",
      effort: "medium",
      source: "you",
    });
  });

  it("no such row: a new one", () => {
    const next = withSimpleTask([row("Anything with UI")], sel("uno", "uno/uno/fast"));
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ taskType: "Simple tasks, small fixes", source: "you" });
  });

  it("sameSelection ignores options", () => {
    expect(sameSelection(sel("codex", "a"), { ...sel("codex", "a") })).toBe(true);
    expect(sameSelection(sel("codex", "a"), null)).toBe(false);
  });
});

describe("planAutoRoles: Uno applies its set by itself, never over the person's choice", () => {
  const now = "2026-11-14T03:00:00.000Z";
  const untouched = {
    complex: null,
    simple: { selection: sel("claudeAgent", "claude-sonnet-5-5"), mine: false },
    replies: { provider: "uno", model: "uno/smart" },
  } as const;
  const unoOnly = suggestRoles({ providers: [uno], isReady: ready, unoReplies: true });
  const both = suggestRoles({ providers: [uno, codex, claude], isReady: ready, unoReplies: true });

  it("only Uno AI: Smart / Fast without pressing a button", () => {
    const plan = planAutoRoles({
      roles: unoOnly,
      autoComplex: null,
      preset: null,
      current: untouched,
      now,
    });
    expect(plan?.complex).toEqual(sel("uno", "uno/uno/smart"));
    expect(plan?.simple).toEqual(sel("uno", "uno/uno/fast"));
    expect(plan?.replies).toEqual({ provider: "uno", model: "uno/fast" });
    expect(plan?.preset).toEqual({
      sources: ["uno"],
      complex: sel("uno", "uno/uno/smart"),
      simple: sel("uno", "uno/uno/fast"),
      replies: { provider: "uno", model: "uno/fast" },
      appliedAt: now,
    });
  });

  it("the person's own choices are kept, the untouched roles still get the set", () => {
    const plan = planAutoRoles({
      roles: unoOnly,
      autoComplex: null,
      preset: null,
      current: {
        complex: sel("claudeAgent", "claude-opus-5-5"),
        simple: { selection: sel("claudeAgent", "claude-sonnet-5-5"), mine: true },
        replies: { provider: "claude", model: "claude-opus-5-5" },
      },
      now,
    });
    expect(plan).not.toBeNull();
    expect(plan).not.toHaveProperty("complex");
    expect(plan).not.toHaveProperty("simple");
    expect(plan).not.toHaveProperty("replies");
    // Remembered as the person's: a later plan won't take them either.
    expect(plan?.preset).toEqual({ sources: ["uno"], appliedAt: now });
  });

  it("the first own plan: Uno's earlier set moves on, back to Auto (Opus 5.5)", () => {
    const first = planAutoRoles({
      roles: unoOnly,
      autoComplex: null,
      preset: null,
      current: untouched,
      now,
    })!;
    const plan = planAutoRoles({
      roles: both,
      autoComplex: sel("claudeAgent", "claude-opus-5-5"),
      preset: first.preset,
      current: {
        complex: first.complex!,
        simple: { selection: first.simple!, mine: true },
        replies: first.replies!,
      },
      now,
    });
    expect(plan?.complex).toBeNull();
    expect(plan?.simple).toEqual(sel("codex", "gpt-5.6-luna"));
    expect(plan).not.toHaveProperty("replies"); // already Uno Fast
    expect(plan?.preset.sources).toEqual(["claude", "codex", "uno"]);
  });

  it("a role the person changed after Uno's set stays theirs when the plan comes", () => {
    const first = planAutoRoles({
      roles: unoOnly,
      autoComplex: null,
      preset: null,
      current: untouched,
      now,
    })!;
    const plan = planAutoRoles({
      roles: both,
      autoComplex: sel("claudeAgent", "claude-opus-5-5"),
      preset: first.preset,
      current: {
        complex: sel("uno", "uno/uno/fast"), // picked by hand
        simple: { selection: sel("uno", "uno/uno/smart"), mine: true }, // picked by hand
        replies: { provider: "uno", model: "uno/smart" }, // picked by hand
      },
      now,
    });
    expect(plan).not.toHaveProperty("complex");
    expect(plan).not.toHaveProperty("simple");
    expect(plan).not.toHaveProperty("replies");
  });

  it("after the first own plan: nothing by itself, changes wait for Use these", () => {
    const withPlan = planAutoRoles({
      roles: both,
      autoComplex: sel("claudeAgent", "claude-opus-5-5"),
      preset: null,
      current: untouched,
      now,
    })!;
    expect(withPlan.complex).toBeUndefined(); // Auto already gives Opus 5.5
    expect(withPlan.simple).toEqual(sel("codex", "gpt-5.6-luna"));
    expect(
      planAutoRoles({
        roles: both,
        autoComplex: null,
        preset: withPlan.preset,
        current: untouched,
        now,
      }),
    ).toBeNull();
    // Still only Uno AI and a set applied: nothing again.
    const first = planAutoRoles({ roles: unoOnly, autoComplex: null, preset: null, current: untouched, now })!;
    expect(
      planAutoRoles({ roles: unoOnly, autoComplex: null, preset: first.preset, current: untouched, now }),
    ).toBeNull();
  });

  it("not known yet (no ROUTING.md, no assistant AI): those roles are left alone", () => {
    const plan = planAutoRoles({
      roles: unoOnly,
      autoComplex: null,
      preset: null,
      current: { complex: null },
      now,
    });
    expect(plan?.complex).toEqual(sel("uno", "uno/uno/smart"));
    expect(plan).not.toHaveProperty("simple");
    expect(plan).not.toHaveProperty("replies");
    expect(plan?.preset).not.toHaveProperty("simple");
  });
});
