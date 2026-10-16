import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { EMPTY_SETUP_PROGRESS } from "../../setup/setupModel";
import {
  AGENT_START_STEP,
  briefStartFor,
  shouldApplyAccountAgent,
  agentDriverFromAccountDefault,
  agentStartDoneHere,
  nextStepIdForSetupStep,
  parseAgentDriver,
  pickAgentDriver,
  shouldAutoOpenAgentSignIn,
  signedInWithOwnAccount,
} from "./agentStart";

const provider = (
  auth: ServerProvider["auth"],
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: "claudeAgent" as ServerProvider["instanceId"],
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.0",
  status: "ready",
  auth,
  checkedAt: "2026-10-16T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("parseAgentDriver", () => {
  it("reads the entry link's agent", () => {
    expect(parseAgentDriver("claude")).toBe("claudeAgent");
    expect(parseAgentDriver(" Codex ")).toBe("codex");
    expect(parseAgentDriver("claudeAgent")).toBe("claudeAgent");
    expect(parseAgentDriver("opencode")).toBeNull();
    expect(parseAgentDriver("<script>")).toBeNull();
    expect(parseAgentDriver(null)).toBeNull();
  });

  it("the account's default AI means a CLI only for Claude and Codex", () => {
    expect(agentDriverFromAccountDefault("claude")).toBe("claudeAgent");
    expect(agentDriverFromAccountDefault("codex")).toBe("codex");
    expect(agentDriverFromAccountDefault("uno")).toBeNull();
    expect(agentDriverFromAccountDefault("byok")).toBeNull();
  });
});

describe("pickAgentDriver", () => {
  it("the link first, then this computer, then the account; Claude Code by default", () => {
    expect(pickAgentDriver({ arrived: "codex", saved: "claudeAgent", accountDefault: null })).toBe(
      "codex",
    );
    expect(pickAgentDriver({ arrived: null, saved: "codex", accountDefault: "claudeAgent" })).toBe(
      "codex",
    );
    expect(pickAgentDriver({ arrived: null, saved: null, accountDefault: "codex" })).toBe("codex");
    expect(pickAgentDriver({ arrived: null, saved: null, accountDefault: null })).toBe(
      "claudeAgent",
    );
  });
});

describe("signedInWithOwnAccount", () => {
  it("the plan's Uno AI credit is not the person's sign-in", () => {
    expect(
      signedInWithOwnAccount(provider({ status: "authenticated", type: "subscription" })),
    ).toBe(true);
    expect(signedInWithOwnAccount(provider({ status: "authenticated", type: "unoAi" }))).toBe(
      false,
    );
    expect(signedInWithOwnAccount(provider({ status: "unauthenticated" }))).toBe(false);
    expect(
      signedInWithOwnAccount(provider({ status: "authenticated" }, { installed: false })),
    ).toBe(false);
    expect(signedInWithOwnAccount(null)).toBe(false);
  });
});

describe("shouldAutoOpenAgentSignIn", () => {
  const base = {
    lite: false,
    arrived: "claudeAgent" as const,
    accountDefault: null,
    prompted: false,
    provider: provider({ status: "unauthenticated" }),
  };

  it("opens once after the person picked their agent before Work", () => {
    expect(shouldAutoOpenAgentSignIn(base)).toBe(true);
    // No link, but Claude as the account's AI — any goal (walk 16.10: a bot with "Yes, Claude").
    expect(
      shouldAutoOpenAgentSignIn({ ...base, arrived: null, accountDefault: "claudeAgent" }),
    ).toBe(true);
    // Claude Code on Uno AI's credit still needs the person's own sign-in.
    expect(
      shouldAutoOpenAgentSignIn({
        ...base,
        provider: provider({ status: "authenticated", type: "unoAi" }),
      }),
    ).toBe(true);
  });

  it("never twice, never without a pick, never when signed in or not installed", () => {
    expect(shouldAutoOpenAgentSignIn({ ...base, prompted: true })).toBe(false);
    expect(shouldAutoOpenAgentSignIn({ ...base, arrived: null })).toBe(false);

    expect(
      shouldAutoOpenAgentSignIn({
        ...base,
        provider: provider({ status: "authenticated", type: "subscription" }),
      }),
    ).toBe(false);
    expect(
      shouldAutoOpenAgentSignIn({
        ...base,
        provider: provider({ status: "unauthenticated" }, { installed: false }),
      }),
    ).toBe(false);
    expect(shouldAutoOpenAgentSignIn({ ...base, provider: null })).toBe(false);
    expect(shouldAutoOpenAgentSignIn({ ...base, lite: true })).toBe(false);
  });
});

describe("agentStartDoneHere", () => {
  it("knows what this computer already did", () => {
    const done = agentStartDoneHere({
      agentSignedIn: true,
      progress: {
        ...EMPTY_SETUP_PROGRESS,
        visited: ["skills", "connectors"],
        skipped: ["connectors"],
        project: { id: "p1", path: "/home/u/acme", name: "acme", kind: "site" },
      },
      channelOn: false,
    });
    expect(done).toEqual(
      new Set([
        AGENT_START_STEP.connectAgent,
        AGENT_START_STEP.addProject,
        AGENT_START_STEP.addSkills,
      ]),
    );
  });

  it("Telegram or Slack already on closes the channel step", () => {
    const done = agentStartDoneHere({
      agentSignedIn: false,
      progress: EMPTY_SETUP_PROGRESS,
      channelOn: true,
    });
    expect([...done]).toEqual([AGENT_START_STEP.connectChannel]);
  });

  it("the setup steps map back to the card's ids", () => {
    expect(nextStepIdForSetupStep("skills")).toBe("add_skills");
    expect(nextStepIdForSetupStep("connectors")).toBe("connect_tools");
    expect(nextStepIdForSetupStep("channels")).toBe("connect_channel");
    expect(nextStepIdForSetupStep("project")).toBeNull();
  });
});

describe("shouldApplyAccountAgent", () => {
  const claude = provider({ status: "unauthenticated" });
  const hermes = provider(
    { status: "authenticated" },
    {
      instanceId: "hermes" as ServerProvider["instanceId"],
      driver: ProviderDriverKind.make("hermes"),
    },
  );
  const codex = provider(
    { status: "authenticated", type: "subscription" },
    {
      instanceId: "codex" as ServerProvider["instanceId"],
      driver: ProviderDriverKind.make("codex"),
    },
  );
  const providers = [claude, hermes, codex];

  it("'Yes, Claude' in the console: new chats start on Claude, not Uno AI", () => {
    const base = { accountDefault: "claudeAgent" as const, applied: undefined, providers };
    expect(shouldApplyAccountAgent({ ...base, stickyActive: null })).toBe(true);
    // Uno's engine as the last pick is the machine default (a fresh computer).
    expect(shouldApplyAccountAgent({ ...base, stickyActive: "hermes" })).toBe(true);
  });

  it("never over the person's own pick, never twice, never without the harness", () => {
    const base = { accountDefault: "claudeAgent" as const, providers };
    expect(shouldApplyAccountAgent({ ...base, applied: undefined, stickyActive: "codex" })).toBe(
      false,
    );
    expect(shouldApplyAccountAgent({ ...base, applied: "claudeAgent", stickyActive: null })).toBe(
      false,
    );
    expect(
      shouldApplyAccountAgent({
        ...base,
        applied: undefined,
        stickyActive: null,
        providers: [hermes],
      }),
    ).toBe(false);
    expect(
      shouldApplyAccountAgent({
        accountDefault: null,
        applied: undefined,
        stickyActive: null,
        providers,
      }),
    ).toBe(false);
  });
});

describe("briefStartFor", () => {
  it("the console's brief goes to the account's agent: now when signed in, typed when not", () => {
    const signed = provider({ status: "authenticated", type: "subscription" });
    expect(briefStartFor({ accountDefault: "claudeAgent", providers: [signed] })).toBe("send");
    expect(
      briefStartFor({
        accountDefault: "claudeAgent",
        providers: [provider({ status: "unauthenticated" })],
      }),
    ).toBe("type");
    // On the plan's Uno AI credit: still the person's sign-in first, not Uno AI hours.
    expect(
      briefStartFor({
        accountDefault: "claudeAgent",
        providers: [provider({ status: "authenticated", type: "unoAi" })],
      }),
    ).toBe("type");
  });

  it("no own agent chosen, or it isn't here: Uno, as before", () => {
    expect(briefStartFor({ accountDefault: null, providers: [] })).toBeNull();
    expect(
      briefStartFor({
        accountDefault: "codex",
        providers: [provider({ status: "authenticated" })],
      }),
    ).toBeNull();
  });
});
