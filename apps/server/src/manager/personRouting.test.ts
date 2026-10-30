import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { LEGACY_NO_CLAUDE_NOTE, ROUTING_TEMPLATE, upgradeRoutingNotes } from "./routingTemplate.ts";
import { applyPersonRoute, selectionNotReadyMessage } from "./personRouting.ts";

const provider = (
  driver: string,
  patch: Partial<Record<string, unknown>> = {},
  models: ReadonlyArray<string> = [],
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(driver),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-29T00:00:00.000Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
    ...patch,
  }) as unknown as ServerProvider;

const claudeEverywhere = {
  harness: "claudeAgent",
  model: "claude-opus-5-5",
  thinking: "high" as const,
  taskType: null,
};
const smart = { instanceId: ProviderInstanceId.make("uno"), model: "uno/uno/smart" };

describe("applyPersonRoute", () => {
  it("the person's table wins over the model's Smart", () => {
    const routed = applyPersonRoute({
      route: claudeEverywhere,
      requested: smart,
      personAsked: false,
      providers: [provider("uno"), provider("claudeAgent", {}, ["claude-opus-5-5"])],
    });
    expect(routed).toEqual({
      kind: "selection",
      route: claudeEverywhere,
      selection: {
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      },
    });
  });

  it("what the person asked for in the chat wins over their table", () => {
    expect(
      applyPersonRoute({
        route: claudeEverywhere,
        requested: smart,
        personAsked: true,
        providers: [provider("claudeAgent")],
      }),
    ).toEqual({ kind: "none" });
  });

  it("Claude not signed in: no chat on another model, a line to ask", () => {
    const routed = applyPersonRoute({
      route: claudeEverywhere,
      requested: smart,
      personAsked: false,
      providers: [
        provider("uno"),
        provider("claudeAgent", { auth: { status: "unauthenticated" } }),
      ],
    });
    expect(routed.kind).toBe("not-ready");
    if (routed.kind === "not-ready") {
      expect(routed.message).toContain("Claude is not signed in");
      expect(routed.message).toContain("Settings → Agents → Sign in");
    }
  });

  it("Claude not installed: not ready either", () => {
    expect(
      applyPersonRoute({
        route: claudeEverywhere,
        requested: null,
        personAsked: false,
        providers: [provider("uno")],
      }).kind,
    ).toBe("not-ready");
  });

  it("a model this computer doesn't offer: the newest of its family", () => {
    const routed = applyPersonRoute({
      route: { ...claudeEverywhere, model: "claude-opus-4-1", thinking: null },
      requested: null,
      personAsked: false,
      providers: [provider("claudeAgent", {}, ["claude-opus-5-5", "claude-sonnet-5-5"])],
    });
    expect(routed).toMatchObject({ selection: { model: "claude-opus-5-5" } });
  });

  it("no rule: as before", () => {
    expect(
      applyPersonRoute({ route: null, requested: smart, personAsked: false, providers: [] }),
    ).toEqual({ kind: "none" });
  });
});

describe("selectionNotReadyMessage (any chat an assistant starts)", () => {
  // Canary 30.10: the account default AI was Claude, not signed in; the chat
  // died on start and Uno re-ran it on Smart by itself.
  const claude = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-5" };

  it("Claude not signed in: not started, ask the person", () => {
    const message = selectionNotReadyMessage(claude, [
      provider("uno"),
      provider("claudeAgent", { auth: { status: "unauthenticated" } }),
    ]);
    expect(message).toContain("Claude is not signed in");
    expect(message).toContain("NOT started");
    expect(message).toContain("Не стартовал");
  });

  it("Claude on Uno AI without Uno credits allowed: not started (canary 30.10)", () => {
    const onUnoAi = provider("claudeAgent", { auth: { status: "authenticated", type: "unoAi" } });
    const message = selectionNotReadyMessage(claude, [onUnoAi]);
    expect(message).toContain("NOT started");
    expect(message).toContain("allow it to use Uno credits");
    expect(selectionNotReadyMessage(claude, [onUnoAi], { claudeAgent: true })).toBeNull();
  });

  it("ready, or a provider this computer doesn't list: start as before", () => {
    expect(selectionNotReadyMessage(claude, [provider("claudeAgent")])).toBeNull();
    expect(selectionNotReadyMessage(claude, [provider("uno")])).toBeNull();
  });
});

describe("ROUTING notes upgrade", () => {
  it("the shipped template has no silent Smart fallback", () => {
    expect(ROUTING_TEMPLATE).not.toContain(LEGACY_NO_CLAUDE_NOTE);
    expect(ROUTING_TEMPLATE).toContain("never another");
  });

  it("an untouched old note is replaced, an edited file is left alone", () => {
    const old = ROUTING_TEMPLATE.replace(
      /- The person's word wins[\s\S]*?say which model in your one line\.\n/,
      `${LEGACY_NO_CLAUDE_NOTE}\n`,
    );
    expect(old).toContain(LEGACY_NO_CLAUDE_NOTE);
    expect(upgradeRoutingNotes(old)).toBe(ROUTING_TEMPLATE);
    expect(upgradeRoutingNotes(ROUTING_TEMPLATE)).toBeNull();
    expect(upgradeRoutingNotes(old.replace("uno/uno/smart", "uno/uno/max"))).toBeNull();
  });
});
