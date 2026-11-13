import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  LEGACY_NO_CLAUDE_NOTE,
  PERSON_FIRST_NOTE,
  PERSON_FIRST_NOTE_1029,
  ROUTING_TEMPLATE,
  upgradeRoutingNotes,
} from "./routingTemplate.ts";
import {
  applyPersonRoute,
  applyTableRoute,
  defaultModelChoice,
  selectionNotReadyMessage,
  strongestReadyModelSelection,
} from "./personRouting.ts";

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

describe("applyTableRoute (a default / learned row)", () => {
  const hardBugs = {
    harness: "claudeAgent",
    model: "claude-opus-5-5",
    thinking: "max" as const,
    taskType: "Hard bugs",
  };

  it("its harness ready here: used as the row says", () => {
    expect(
      applyTableRoute({
        route: hardBugs,
        providers: [provider("claudeAgent", {}, ["claude-opus-5-5"])],
      }),
    ).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "max" }],
    });
  });

  it("not ready (or Uno credits not allowed): no error, the next step decides", () => {
    expect(
      applyTableRoute({
        route: hardBugs,
        providers: [provider("claudeAgent", { auth: { status: "unauthenticated" } })],
      }),
    ).toBeNull();
    expect(
      applyTableRoute({
        route: hardBugs,
        providers: [
          provider("claudeAgent", { auth: { status: "authenticated", type: "unoAi" } }, [
            "claude-opus-5-5",
          ]),
        ],
      }),
    ).toBeNull();
    expect(applyTableRoute({ route: null, providers: [provider("claudeAgent")] })).toBeNull();
  });
});

describe("strongestReadyModelSelection (replaces the account's onboarding AI)", () => {
  it("account 2709: Codex listing Luna first runs on Terra, Claude ready wins over both", () => {
    const codex = provider("codex", {}, ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]);
    expect(strongestReadyModelSelection([codex])).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-terra",
    });
    expect(
      strongestReadyModelSelection([codex, provider("claudeAgent", {}, ["claude-opus-5-5"])]),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
  });

  it("Claude on Uno credits counts only when allowed here", () => {
    const claudeOnUno = provider(
      "claudeAgent",
      { auth: { status: "authenticated", type: "unoAi" } },
      ["claude-opus-5-5"],
    );
    expect(strongestReadyModelSelection([claudeOnUno])).toBeNull();
    expect(strongestReadyModelSelection([claudeOnUno], { claudeAgent: true })).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });
});

describe("ROUTING notes upgrade", () => {
  it("the shipped template has no silent Smart fallback", () => {
    expect(ROUTING_TEMPLATE).not.toContain(LEGACY_NO_CLAUDE_NOTE);
    expect(ROUTING_TEMPLATE).toContain("never another");
  });

  it("an untouched old note is replaced, an edited file is left alone", () => {
    const old = ROUTING_TEMPLATE.replace(PERSON_FIRST_NOTE, LEGACY_NO_CLAUDE_NOTE);
    expect(old).toContain(LEGACY_NO_CLAUDE_NOTE);
    expect(upgradeRoutingNotes(old)).toBe(ROUTING_TEMPLATE);
    expect(upgradeRoutingNotes(ROUTING_TEMPLATE)).toBeNull();
    expect(upgradeRoutingNotes(old.replace("uno/uno/smart", "uno/uno/max"))).toBeNull();
  });

  it("the 29.10 note (Smart for a default row not ready) becomes the strongest-ready one", () => {
    const old1029 = ROUTING_TEMPLATE.replace(PERSON_FIRST_NOTE, PERSON_FIRST_NOTE_1029);
    expect(old1029).toContain("uno/uno/smart");
    expect(upgradeRoutingNotes(old1029)).toBe(ROUTING_TEMPLATE);
    expect(ROUTING_TEMPLATE).not.toContain("uno/uno/smart");
  });
});

describe('defaultModelChoice (Settings → AI "Default model", 13.11 v2)', () => {
  const terra = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-terra" };
  const codex = provider("codex", {}, ["gpt-5.6-luna", "gpt-5.6-terra"]);

  it("is the person's pick when its harness is ready and lists the model", () => {
    expect(defaultModelChoice(terra, [codex])).toEqual(terra);
  });

  it("Auto (null), a harness not ready or a model gone: null, so Auto decides", () => {
    expect(defaultModelChoice(null, [codex])).toBeNull();
    expect(
      defaultModelChoice(terra, [provider("codex", { auth: { status: "unauthenticated" } })]),
    ).toBeNull();
    expect(defaultModelChoice(terra, [provider("codex", {}, ["gpt-5.6-luna"])])).toBeNull();
    expect(defaultModelChoice(terra, [])).toBeNull();
  });

  it("Claude Code on Uno credits only when they're allowed here", () => {
    const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
    const onCredits = provider(
      "claudeAgent",
      { auth: { status: "authenticated", type: "unoAi" } },
      ["claude-opus-5-5"],
    );
    expect(defaultModelChoice(opus, [onCredits])).toBeNull();
    expect(defaultModelChoice(opus, [onCredits], { claudeAgent: true })).toEqual(opus);
  });
});
