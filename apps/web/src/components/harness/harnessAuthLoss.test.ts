import {
  ASSISTANT_PROJECT_ID,
  ProviderDriverKind,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { assistantModelSelection } from "@t3tools/shared/assistantLlm";
import { describe, expect, it } from "vitest";

import {
  CURSOR_LOGIN_COMMAND,
  detectHarnessAuthLoss,
  type DetectHarnessAuthLossInput,
  type HarnessAuthLossThread,
  isBillingErrorText,
  resolveThreadHarnessAuthLoss,
  shouldReprobeProvider,
} from "./harnessAuthLoss";

const makeProvider = (driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: driver as ServerProvider["instanceId"],
  driver: ProviderDriverKind.make(driver),
  displayName: "",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-24T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const signedOut = (driver: string) =>
  makeProvider(driver, { status: "error", auth: { status: "unauthenticated" } });

const input = (overrides: Partial<DetectHarnessAuthLossInput>): DetectHarnessAuthLossInput => ({
  driver: null,
  providerStatus: null,
  threadError: null,
  sessionLastError: null,
  isCustom: false,
  ...overrides,
});

describe("detectHarnessAuthLoss — provider snapshot", () => {
  it.each([
    ["codex", "signIn", "Codex"],
    ["claudeAgent", "signIn", "Claude"],
    ["opencode", "updateKey", "OpenCode"],
    ["cursor", "cursorCli", "Cursor"],
    ["uno", "unoAccount", "Uno AI"],
  ] as const)("%s signed out → %s", (driver, kind, label) => {
    const loss = detectHarnessAuthLoss(input({ driver, providerStatus: signedOut(driver) }));
    expect(loss?.kind).toBe(kind);
    expect(loss?.source).toBe("status");
    expect(loss?.title).toBe(`You were signed out of ${label}`);
  });

  it("uses the instance's display name", () => {
    const loss = detectHarnessAuthLoss(
      input({
        driver: "codex",
        providerStatus: { ...signedOut("codex"), displayName: "Codex Personal" },
      }),
    );
    expect(loss?.harnessLabel).toBe("Codex Personal");
  });

  it("is quiet for a signed-in harness", () => {
    expect(
      detectHarnessAuthLoss(input({ driver: "codex", providerStatus: makeProvider("codex") })),
    ).toBeNull();
  });

  it("does not call a missing binary signed out", () => {
    const provider = makeProvider("codex", {
      installed: false,
      status: "error",
      auth: { status: "unauthenticated" },
    });
    expect(
      detectHarnessAuthLoss(
        input({ driver: "codex", providerStatus: provider, threadError: "401 Unauthorized" }),
      ),
    ).toBeNull();
  });

  it("does not read unknown auth as signed out", () => {
    const provider = makeProvider("codex", { auth: { status: "unknown" } });
    expect(detectHarnessAuthLoss(input({ driver: "codex", providerStatus: provider }))).toBeNull();
  });
});

describe("detectHarnessAuthLoss — error text", () => {
  it.each([
    ["codex", "Codex CLI is not authenticated. Run `codex login` and try again."],
    ["codex", "unexpected status 401 Unauthorized"],
    ["codex", "Your refresh token was already used. Please log out and sign in again."],
    ["codex", "Your access token expired"],
    ["claudeAgent", "Invalid API key · Please run /login"],
    ["claudeAgent", 'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'],
    [
      "claudeAgent",
      "OAuth token has expired. Please obtain a new token or refresh your existing token.",
    ],
    ["opencode", "AI_APICallError: invalid x-api-key"],
    ["opencode", "Incorrect API key provided: sk-abc"],
    ["uno", "gateway returned 401"],
    ["uno", "Invalid API key"],
    ["cursor", "Cursor Agent is not authenticated. Run `agent login`."],
  ])("%s: %s", (driver, text) => {
    const loss = detectHarnessAuthLoss(
      input({ driver, providerStatus: makeProvider(driver), threadError: text }),
    );
    expect(loss).not.toBeNull();
    expect(loss?.source).toBe("error");
  });

  it("reads the session's last error too", () => {
    const loss = detectHarnessAuthLoss(
      input({ driver: "codex", sessionLastError: "401 Unauthorized" }),
    );
    expect(loss?.kind).toBe("signIn");
  });

  it("does not match an unrelated error", () => {
    expect(
      detectHarnessAuthLoss(
        input({ driver: "codex", threadError: "Connection reset by peer (port 4010)" }),
      ),
    ).toBeNull();
    expect(
      detectHarnessAuthLoss(
        input({ driver: "claudeAgent", threadError: "Rate limited, try later" }),
      ),
    ).toBeNull();
  });

  it("gives Cursor the terminal command", () => {
    const loss = detectHarnessAuthLoss(
      input({ driver: "cursor", threadError: "not authenticated" }),
    );
    expect(loss?.command).toBe(CURSOR_LOGIN_COMMAND);
    expect(loss?.actionLabel).toBe("Sign in again");
  });

  it("labels OpenCode's action Update key", () => {
    const loss = detectHarnessAuthLoss(input({ driver: "opencode", threadError: "401" }));
    expect(loss?.actionLabel).toBe("Update key");
  });
});

describe("detectHarnessAuthLoss — billing is not a sign-in", () => {
  it.each([
    "402 Payment Required",
    "Uno LLM credits are empty.",
    "insufficient_balance",
    "workspace_owner_credits_depleted (401)",
  ])("%s", (text) => {
    expect(isBillingErrorText(text)).toBe(true);
    expect(
      detectHarnessAuthLoss(
        input({ driver: "uno", providerStatus: makeProvider("uno"), threadError: text }),
      ),
    ).toBeNull();
  });

  it("trusts the session's billing class over the text", () => {
    expect(
      detectHarnessAuthLoss(
        input({
          driver: "uno",
          threadError: "401 Unauthorized",
          sessionLastErrorClass: "billing_error",
        }),
      ),
    ).toBeNull();
  });
});

describe("detectHarnessAuthLoss — custom harnesses", () => {
  it("keeps a plain error for a custom ACP harness", () => {
    expect(
      detectHarnessAuthLoss(
        input({ driver: "acp", isCustom: true, threadError: "401 Unauthorized" }),
      ),
    ).toBeNull();
  });

  it("ignores drivers it does not know", () => {
    expect(
      detectHarnessAuthLoss(input({ driver: "somethingElse", threadError: "401 Unauthorized" })),
    ).toBeNull();
  });
});

describe("detectHarnessAuthLoss — assistant (Hermes)", () => {
  it("own key rejected → assistantKey with the provider's name", () => {
    const loss = detectHarnessAuthLoss(
      input({
        driver: "hermes",
        providerStatus: makeProvider("hermes"),
        threadError: "Error code: 401 - Incorrect API key provided",
        assistantLlmProvider: "openai",
      }),
    );
    expect(loss?.kind).toBe("assistantKey");
    expect(loss?.title).toBe("Your OpenAI key stopped working");
    expect(loss?.actionLabel).toBe("Update key");
  });

  it("own key: 403 counts, a Hermes snapshot without the Uno key does not", () => {
    expect(
      detectHarnessAuthLoss(
        input({ driver: "hermes", threadError: "403 Forbidden", assistantLlmProvider: "xai" }),
      )?.kind,
    ).toBe("assistantKey");
    expect(
      detectHarnessAuthLoss(
        input({
          driver: "hermes",
          providerStatus: signedOut("hermes"),
          assistantLlmProvider: "openrouter",
        }),
      ),
    ).toBeNull();
  });

  it("Uno gateway → unoAccount, from the snapshot or a 401", () => {
    expect(
      detectHarnessAuthLoss(
        input({
          driver: "hermes",
          providerStatus: signedOut("hermes"),
          assistantLlmProvider: "uno",
        }),
      )?.kind,
    ).toBe("unoAccount");
    expect(
      detectHarnessAuthLoss(
        input({
          driver: "hermes",
          threadError: "401 invalid api key",
          assistantLlmProvider: "uno",
        }),
      )?.kind,
    ).toBe("unoAccount");
  });

  it("billing on the gateway stays with the top-up banner", () => {
    expect(
      detectHarnessAuthLoss(
        input({ driver: "hermes", threadError: "402 no_money", assistantLlmProvider: "uno" }),
      ),
    ).toBeNull();
  });
});

describe("resolveThreadHarnessAuthLoss", () => {
  const codexSelection: ModelSelection = {
    instanceId: "codex" as ModelSelection["instanceId"],
    model: "gpt-5",
  };
  const thread = (overrides: Partial<HarnessAuthLossThread>): HarnessAuthLossThread => ({
    projectId: "project-1",
    assistantRole: null,
    modelSelection: codexSelection,
    error: null,
    session: null,
    ...overrides,
  });

  it("an assistant chat with a stale Codex session never shows Codex", () => {
    const result = resolveThreadHarnessAuthLoss({
      thread: thread({
        assistantRole: "chat",
        session: {
          provider: "codex",
          providerInstanceId: "codex",
          lastError: "Codex CLI is not authenticated. Run `codex login` and try again.",
        },
        error: "Codex CLI is not authenticated. Run `codex login` and try again.",
      }),
      providerStatuses: [signedOut("codex"), makeProvider("hermes")],
      activeProviderStatus: signedOut("codex"),
    });
    expect(result.isAssistant).toBe(true);
    expect(result.providerStatus?.instanceId).toBe("hermes");
    expect(result.loss).toBeNull();
    // The stale Codex sign-in error is not shown raw either.
    expect(result.suppressThreadError).toBe(true);
  });

  it("an assistant chat (by project) whose turn failed on the Uno key → Hermes card", () => {
    const result = resolveThreadHarnessAuthLoss({
      thread: thread({
        projectId: ASSISTANT_PROJECT_ID,
        session: {
          provider: "hermes",
          providerInstanceId: "hermes",
          lastError: "401 Unauthorized",
        },
      }),
      providerStatuses: [signedOut("hermes")],
      activeProviderStatus: null,
    });
    expect(result.loss?.kind).toBe("unoAccount");
    expect(result.loss?.driver).toBe("hermes");
  });

  it("an assistant chat on a machine without a Uno key yet leaves it to the engine banner", () => {
    const result = resolveThreadHarnessAuthLoss({
      thread: thread({ projectId: ASSISTANT_PROJECT_ID }),
      providerStatuses: [signedOut("hermes")],
      activeProviderStatus: null,
    });
    expect(result.isAssistant).toBe(true);
    expect(result.loss).toBeNull();
  });

  it("an assistant chat on its own key reads the selection's provider", () => {
    const result = resolveThreadHarnessAuthLoss({
      thread: thread({
        assistantRole: "chat",
        modelSelection: assistantModelSelection({ provider: "openrouter", model: "x" }),
        session: {
          provider: "hermes",
          providerInstanceId: "hermes",
          lastError: "401 Unauthorized",
        },
      }),
      providerStatuses: [makeProvider("hermes")],
      activeProviderStatus: null,
    });
    expect(result.loss?.kind).toBe("assistantKey");
    expect(result.loss?.harnessLabel).toBe("OpenRouter");
    expect(result.suppressThreadError).toBe(true);
  });

  it("a spawned work chat is not the assistant", () => {
    const result = resolveThreadHarnessAuthLoss({
      thread: thread({
        projectId: ASSISTANT_PROJECT_ID,
        assistantRole: "spawned",
        error: "401 Unauthorized",
        session: { provider: "codex" },
      }),
      providerStatuses: [],
      activeProviderStatus: makeProvider("codex"),
    });
    expect(result.isAssistant).toBe(false);
    expect(result.loss?.kind).toBe("signIn");
  });

  it("a custom harness chat keeps the plain error", () => {
    const result = resolveThreadHarnessAuthLoss({
      thread: thread({ error: "401 Unauthorized", session: { provider: "acp" } }),
      providerStatuses: [],
      activeProviderStatus: makeProvider("acp"),
    });
    expect(result.loss).toBeNull();
    expect(result.suppressThreadError).toBe(false);
  });

  it("reads Claude's short 'Not logged in' reply as a lost sign-in, not a long answer", () => {
    const claude = makeProvider("claudeAgent");
    const signedOutReply = resolveThreadHarnessAuthLoss({
      thread: thread({
        messages: [
          { role: "user", text: "Say hi" },
          { role: "assistant", text: "Not logged in · Please run /login", streaming: false },
        ],
      }),
      providerStatuses: [claude],
      activeProviderStatus: claude,
    });
    expect(signedOutReply.loss?.kind).toBe("signIn");
    expect(signedOutReply.loss?.driver).toBe("claudeAgent");
    const answer = resolveThreadHarnessAuthLoss({
      thread: thread({
        messages: [
          {
            role: "assistant",
            text: `To deploy, run /login in the CLI first. ${"Then follow the steps. ".repeat(20)}`,
          },
        ],
      }),
      providerStatuses: [claude],
      activeProviderStatus: claude,
    });
    expect(answer.loss).toBeNull();
  });
});

describe("shouldReprobeProvider", () => {
  it("re-probes once a turn failed on auth but the snapshot still says signed in", () => {
    const provider = makeProvider("codex");
    const loss = detectHarnessAuthLoss(
      input({ driver: "codex", providerStatus: provider, threadError: "401 Unauthorized" }),
    );
    expect(shouldReprobeProvider(loss, provider)).toBe(true);
  });

  it("does not when the snapshot already says signed out", () => {
    const provider = signedOut("codex");
    const loss = detectHarnessAuthLoss(input({ driver: "codex", providerStatus: provider }));
    expect(shouldReprobeProvider(loss, provider)).toBe(false);
  });
});
