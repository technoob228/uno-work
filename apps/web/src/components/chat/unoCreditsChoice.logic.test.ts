import {
  ProviderDriverKind,
  ProviderInstanceId,
  UNO_SMART_MODEL_SLUG,
  unoCreditsChoiceRequiredText,
  type ServerProvider,
  type UnoAiPremiumStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  UNO_CREDITS_COPY,
  unoCreditsChoiceCopy,
  unoCreditsChoiceNeeded,
  unoSmartTarget,
} from "./unoCreditsChoice.logic";

function provider(
  driver: string,
  auth: ServerProvider["auth"],
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth,
    checkedAt: "2026-10-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as ServerProvider;
}

const claudeOnUnoAi = provider("claudeAgent", {
  status: "authenticated",
  type: "unoAi",
  label: "Uno AI",
});
const claudeOwn = provider("claudeAgent", {
  status: "authenticated",
  type: "claude.ai",
  label: "Claude Max",
});
const claudeUnknown = provider("claudeAgent", { status: "unknown" }, { status: "warning" });

const premium = (overrides: Partial<UnoAiPremiumStatus> = {}): UnoAiPremiumStatus => ({
  limited: true,
  limitUsd: 30,
  leftUsd: 12,
  monthlyUsd: 30,
  overage: false,
  balanceUsd: 0,
  renewsAt: null,
  exhausted: false,
  ...overrides,
});

describe("unoCreditsChoiceNeeded", () => {
  it("not signed in, on Uno AI, nothing chosen: ask before sending", () => {
    expect(
      unoCreditsChoiceNeeded({ provider: claudeOnUnoAi, settings: { harnessUnoCredits: {} } }),
    ).toBe(true);
  });

  it("Uno credits allowed for Claude Code: no question", () => {
    expect(
      unoCreditsChoiceNeeded({
        provider: claudeOnUnoAi,
        settings: { harnessUnoCredits: { claudeAgent: true } },
      }),
    ).toBe(false);
  });

  it("switched off in Settings asks again", () => {
    expect(
      unoCreditsChoiceNeeded({
        provider: claudeOnUnoAi,
        settings: { harnessUnoCredits: { claudeAgent: false } },
      }),
    ).toBe(true);
  });

  it("signed in with the person's own account: never asked", () => {
    expect(
      unoCreditsChoiceNeeded({ provider: claudeOwn, settings: { harnessUnoCredits: {} } }),
    ).toBe(false);
    expect(
      unoCreditsChoiceNeeded({
        provider: claudeOwn,
        settings: { harnessUnoCredits: {} },
        lastError: unoCreditsChoiceRequiredText("Claude Code"),
      }),
    ).toBe(false);
  });

  it("the daemon refused the last turn though the snapshot couldn't tell: ask", () => {
    expect(
      unoCreditsChoiceNeeded({
        provider: claudeUnknown,
        settings: { harnessUnoCredits: {} },
        lastError: unoCreditsChoiceRequiredText("Claude Code"),
      }),
    ).toBe(true);
    expect(
      unoCreditsChoiceNeeded({
        provider: claudeUnknown,
        settings: { harnessUnoCredits: {} },
        lastError: "Something else broke",
      }),
    ).toBe(false);
  });

  it("Uno AI harnesses (Uno Code, Hermes, OpenCode) and Codex are never asked", () => {
    const unoAuth = { status: "authenticated", type: "unoAi" } as const;
    for (const driver of ["uno", "hermes", "opencode", "codex", "cursor"]) {
      expect(
        unoCreditsChoiceNeeded({
          provider: provider(driver, unoAuth),
          settings: { harnessUnoCredits: {} },
        }),
      ).toBe(false);
    }
  });

  it("no provider: nothing to ask", () => {
    expect(unoCreditsChoiceNeeded({ provider: null, settings: null })).toBe(false);
  });
});

describe("unoCreditsChoiceCopy", () => {
  it("with credit: Sign in or Use Uno credits", () => {
    const copy = unoCreditsChoiceCopy({
      driver: "claudeAgent",
      premium: premium(),
      canSwitchToSmart: true,
      queued: false,
    });
    expect(copy.title).toBe("You're not signed in to Claude Code");
    expect(copy.body).toBe(
      "Sign in with your Claude account, or use credits from your Uno account to run Claude Code here.",
    );
    expect(copy.signInLabel).toBe("Sign in");
    expect(copy.creditsAction).toEqual({ kind: "useCredits", label: "Use Uno credits" });
    expect(copy.smartLabel).toBeNull();
    expect(copy.note).toBe(UNO_CREDITS_COPY.creditsNote);
  });

  it("no premium status read yet: still offers Uno credits", () => {
    expect(
      unoCreditsChoiceCopy({
        driver: "claudeAgent",
        premium: null,
        canSwitchToSmart: false,
        queued: false,
      }).creditsAction.kind,
    ).toBe("useCredits");
  });

  it("no premium credit and no money: Add credit, and Smart instead", () => {
    const copy = unoCreditsChoiceCopy({
      driver: "claudeAgent",
      premium: premium({ leftUsd: 0, exhausted: true, balanceUsd: 0 }),
      canSwitchToSmart: true,
      queued: false,
    });
    expect(copy.body).toBe(
      "Sign in with your Claude account, or add credit to your Uno account to run Claude Code here.",
    );
    expect(copy.creditsAction).toMatchObject({ kind: "billing", label: "Add credit" });
    expect(copy.smartLabel).toBe("Use Uno AI · Smart instead");
  });

  it("no premium credit but money on the balance: Continue from balance", () => {
    const copy = unoCreditsChoiceCopy({
      driver: "claudeAgent",
      premium: premium({ leftUsd: 0, exhausted: true, balanceUsd: 8 }),
      canSwitchToSmart: false,
      queued: false,
    });
    expect(copy.creditsAction).toMatchObject({ kind: "billing", label: "Continue from balance" });
    expect(copy.smartLabel).toBeNull();
    expect(copy.note).toBe(UNO_CREDITS_COPY.smartNote);
  });

  it("a message is waiting: says it goes once the person picks", () => {
    expect(
      unoCreditsChoiceCopy({
        driver: "claudeAgent",
        premium: premium(),
        canSwitchToSmart: false,
        queued: true,
      }).note,
    ).toBe(UNO_CREDITS_COPY.queuedNote);
  });
});

describe("unoSmartTarget", () => {
  it("Uno Code with Smart ready", () => {
    const uno = provider(
      "uno",
      { status: "authenticated" },
      {
        models: [{ slug: UNO_SMART_MODEL_SLUG, name: "Smart" } as ServerProvider["models"][number]],
      },
    );
    expect(unoSmartTarget([claudeOnUnoAi, uno])).toEqual({
      instanceId: "uno",
      model: UNO_SMART_MODEL_SLUG,
    });
  });

  it("none without Uno Code", () => {
    expect(unoSmartTarget([claudeOnUnoAi])).toBeNull();
  });
});
