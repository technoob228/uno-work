// Cases ported from upstream T3 Code (pingdotgg/t3code, MIT:
// AntigravityProtocol.test.ts, antigravityAuthSupport.test.ts,
// AntigravityAcpSupport.test.ts) and adapted to Uno Work's ACP layer.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_API_KEY_ENV,
  antigravityAuthMethodFor,
  antigravityAutoApprove,
  antigravityClientInfo,
  antigravityCredentialStore,
  antigravityLoginResponse,
  antigravityModeFor,
  antigravityProcessEnvironment,
  antigravityRefusePrompt,
  antigravityTokenFile,
  antigravityToolOutlivesPrompt,
  describeAntigravityAuth,
  extractAntigravityUserInputQuestion,
  findAntigravityAuthorizationUrl,
  hasAntigravityToken,
  isAntigravitySignInRequiredText,
  isAntigravityVersionSupported,
  legacyAntigravityFamily,
  makeAntigravitySessionUpdateTransform,
  makeAntigravityUserInputResponse,
  parseAntigravityAuthorizationUrl,
  planAntigravityModelSelection,
  probeAntigravityAuth,
  sanitizeAntigravityToolPayload,
} from "./AntigravityAcpSupport.ts";

const loopbackUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code" +
  "&client_id=test-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A46353%2F" +
  "&state=test-opaque-state&code_challenge=test-challenge&code_challenge_method=S256";

const loginUrl =
  "https://accounts.google.com/o/oauth2/auth?access_type=offline&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=login-state";

/** What `agy acp --login` 1.5.16 printed on a cloud computer (24.11.2026), link shortened. */
const LOGIN_OUTPUT = `Open this link in a browser to log in with Google:\n\n  ${loginUrl}\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`;

describe("Antigravity authorization URL", () => {
  it("accepts the link agy prints and finds it in the CLI output", () => {
    expect(parseAntigravityAuthorizationUrl(loopbackUrl)?.kind).toBe("loopback");
    const pending = findAntigravityAuthorizationUrl(LOGIN_OUTPUT);
    expect(pending?.kind).toBe("code");
    expect(pending?.redirectUri).toBe("https://antigravity.google/oauth-callback");
    expect(pending?.state).toBe("login-state");
  });

  it("rejects other origins, ambiguous state, and other redirects", () => {
    for (const invalid of [
      loopbackUrl.replace("https:", "http:"),
      loopbackUrl.replace("accounts.google.com", "accounts.google.com.example.invalid"),
      loopbackUrl.replace("accounts.google.com", "secret@accounts.google.com"),
      loopbackUrl.replace("/o/oauth2/v2/auth", "/another-path"),
      `${loopbackUrl}#secret-fragment`,
      `${loopbackUrl}&state=another-state`,
      loopbackUrl.replace("test-opaque-state", ""),
      loopbackUrl.replace("127.0.0.1", "localhost"),
      loopbackUrl.replace("127.0.0.1", "169.254.169.254"),
      loopbackUrl.replace("46353", "70000"),
      loopbackUrl.replace("46353%2F", "46353%2Fother"),
      loopbackUrl.replace("response_type=code", "response_type=token"),
      loginUrl.replace("antigravity.google", "antigravity.google.example.invalid"),
      "not a URL containing secret-code",
    ]) {
      expect(parseAntigravityAuthorizationUrl(invalid)).toBeUndefined();
    }
  });
});

describe("Antigravity code sign-in", () => {
  it("accepts only a code or the page URL for that sign-in", () => {
    const pending = parseAntigravityAuthorizationUrl(loginUrl)!;
    const page = "https://antigravity.google/oauth-callback?state=login-state&code=4%2F0Ab-c";
    expect(antigravityLoginResponse(pending, " 4/0Ab-code_1.x~ ")).toBe("4/0Ab-code_1.x~");
    expect(antigravityLoginResponse(pending, page)).toBe(page);
    for (const invalid of [
      "",
      "4/0Ab code",
      "4/0Ab\nsecond line",
      page.replace("login-state", "other-state"),
      page.replace("antigravity.google", "evil.example"),
      page.replace("&code=4%2F0Ab-c", ""),
      `${page}&code=again`,
    ]) {
      expect(antigravityLoginResponse(pending, invalid)).toBeUndefined();
    }
  });

  it("recognizes the agent's own not-signed-in answers", () => {
    expect(isAntigravitySignInRequiredText("Authentication required")).toBe(true);
    expect(
      isAntigravitySignInRequiredText(
        "No browser is available here (this is a remote (SSH) session). Run `agy acp --login`",
      ),
    ).toBe(true);
    expect(isAntigravitySignInRequiredText("Rate limit exceeded")).toBe(false);
  });
});

describe("Antigravity process environment", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    GEMINI_API_KEY: "ambient-key",
    GOOGLE_API_KEY: "ambient-google",
    GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
    AGY_ACP_FORCE_FILE_STORAGE: "0",
  } satisfies NodeJS.ProcessEnv;

  it("keeps ambient Google credentials out and forces the sign-in file when asked", () => {
    const env = antigravityProcessEnvironment(base, { store: "file" });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 0");
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
    expect(env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    expect(base.GEMINI_API_KEY).toBe("ambient-key");
  });

  it("leaves the keyring alone and passes only the instance's own key", () => {
    const env = antigravityProcessEnvironment(
      { ...base, [ANTIGRAVITY_API_KEY_ENV]: " instance-key " },
      { store: "keyring", caBundlePath: "/etc/ssl/certs/ca-certificates.crt" },
    );
    expect(env.SSH_CONNECTION).toBeUndefined();
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBe("instance-key");
    expect(env[ANTIGRAVITY_API_KEY_ENV]).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-certificates.crt");
  });
});

describe("Antigravity sign-in state", () => {
  const home = async (token?: string) => {
    const dir = await mkdtemp(nodePath.join(os.tmpdir(), "agy-auth-"));
    const env = { GEMINI_HOME: nodePath.join(dir, ".gemini") };
    if (token !== undefined) {
      const file = antigravityTokenFile(env);
      await mkdir(nodePath.dirname(file), { recursive: true });
      await writeFile(file, token);
    }
    return env;
  };

  it("prefers the API key, then the file, then the keyring", () => {
    expect(describeAntigravityAuth({ apiKey: true, tokenFile: true, keyring: true }).type).toBe(
      "gemini-api-key",
    );
    expect(describeAntigravityAuth({ apiKey: false, tokenFile: true, keyring: true }).type).toBe(
      "google-file",
    );
    expect(describeAntigravityAuth({ apiKey: false, tokenFile: false, keyring: true }).type).toBe(
      "google-keyring",
    );
    expect(
      describeAntigravityAuth({ apiKey: false, tokenFile: false, keyring: false }).status,
    ).toBe("unauthenticated");
  });

  it("reads a token the CLI wrote, and not an empty one", () => {
    expect(hasAntigravityToken(JSON.stringify({ token: { refresh_token: "r" } }))).toBe(true);
    expect(hasAntigravityToken(JSON.stringify({ token: {} }))).toBe(false);
    expect(hasAntigravityToken("")).toBe(false);
  });

  it("finds the sign-in file on Linux and uses the file there", async () => {
    const signedIn = await home(JSON.stringify({ token: { access_token: "a" } }));
    expect((await probeAntigravityAuth(signedIn, "linux")).type).toBe("google-file");
    expect(await antigravityCredentialStore(signedIn, "linux")).toBe("file");
    const signedOut = await home();
    expect((await probeAntigravityAuth(signedOut, "linux")).status).toBe("unauthenticated");
    expect(await antigravityCredentialStore(signedOut, "linux")).toBe("file");
    expect(await antigravityCredentialStore(signedOut, "darwin")).toBe("keyring");
    expect(await antigravityCredentialStore(signedIn, "darwin")).toBe("file");
  });

  it("authenticates with the key when one is stored", () => {
    expect(antigravityAuthMethodFor({ [ANTIGRAVITY_API_KEY_ENV]: "k" })).toBe("gemini-api-key");
    expect(antigravityAuthMethodFor({})).toBe("oauth-personal");
  });
});

describe("Antigravity release gates", () => {
  it.each([
    ["1.4.9", false, "zed"],
    ["1.5.0", true, "zed"],
    ["1.5.1", true, "uno-work"],
    ["1.5.16", true, "uno-work"],
    [undefined, true, "zed"],
  ] as const)("%s: chats %s, client %s", (version, supported, client) => {
    expect(isAntigravityVersionSupported(version)).toBe(supported);
    expect(antigravityClientInfo(version, "0.0.194").name).toBe(client);
  });
});

const questionRequest = {
  sessionId: "session-1",
  toolCall: {
    toolCallId: "interaction_9960062f",
    status: "pending",
    title: "Which result label should be used for the verification?",
    rawInput: {},
  },
  options: [
    { optionId: "1", name: "Verified", kind: "allow_once" },
    { optionId: "2", name: "Needs review", kind: "allow_once" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("Antigravity questions", () => {
  const permissionRequest = {
    sessionId: "session-1",
    toolCall: { toolCallId: "command-1", kind: "execute", title: "Run command" },
    options: [
      { optionId: "remember", name: "Allow always", kind: "allow_always" },
      { optionId: "once", name: "Allow", kind: "allow_once" },
      { optionId: "stop", name: "Deny", kind: "reject_once" },
    ],
  } satisfies EffectAcpSchema.RequestPermissionRequest;

  it("routes the native question to a question card, not an approval", () => {
    expect(extractAntigravityUserInputQuestion(questionRequest)).toEqual({
      id: "interaction_9960062f",
      header: "Question",
      question: "Which result label should be used for the verification?",
      multiSelect: false,
      options: [
        { label: "Verified", description: "Verified" },
        { label: "Needs review", description: "Needs review" },
      ],
    });
    expect(extractAntigravityUserInputQuestion(permissionRequest)).toBeUndefined();
    expect(antigravityAutoApprove(questionRequest)).toBeUndefined();
  });

  it("answers with the option for a label or an id", () => {
    for (const answer of ["1", ["1"], "Verified"]) {
      expect(
        makeAntigravityUserInputResponse(questionRequest, { interaction_9960062f: answer }),
      ).toEqual({ outcome: { outcome: "selected", optionId: "1" } });
    }
  });

  it("does not treat a question's reject choice as cancellation", () => {
    const request = {
      ...questionRequest,
      options: [{ optionId: "deny", name: "Do not trust", kind: "reject_once" as const }],
    };
    expect(makeAntigravityUserInputResponse(request, { interaction_9960062f: "deny" })).toEqual({
      outcome: { outcome: "selected", optionId: "deny" },
    });
  });

  it("tells duplicate labels apart", () => {
    const request = {
      ...questionRequest,
      options: questionRequest.options.map((option) => ({ ...option, name: "Same label" })),
    };
    expect(
      extractAntigravityUserInputQuestion(request)?.options.map((option) => option.label),
    ).toEqual(["Same label (1)", "Same label (2)"]);
    expect(
      makeAntigravityUserInputResponse(request, { interaction_9960062f: "Same label" }),
    ).toBeUndefined();
    expect(
      makeAntigravityUserInputResponse(request, { interaction_9960062f: "Same label (2)" }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "2" } });
  });

  it.each([undefined, null, "", "arbitrary answer", [], ["1", "2"], { answer: "1" }, 1])(
    "gives no answer for an unsupported one: %j",
    (answer) => {
      expect(
        makeAntigravityUserInputResponse(questionRequest, { interaction_9960062f: answer }),
      ).toBeUndefined();
    },
  );

  it("rejects missing or duplicate native option IDs", () => {
    for (const optionId of ["", "1"]) {
      const request = {
        ...questionRequest,
        options: [questionRequest.options[0]!, { ...questionRequest.options[1]!, optionId }],
      };
      expect(extractAntigravityUserInputQuestion(request)).toBeUndefined();
    }
  });

  it("bounds question text without splitting a character", () => {
    const title = "Q".repeat(7_994) + "🧪";
    const label = "O".repeat(506) + "🧪";
    const request = {
      ...questionRequest,
      toolCall: { ...questionRequest.toolCall, title: title + "🚀 continued" },
      options: [
        { optionId: "stable-choice", name: label + "🚀 continued", kind: "allow_once" as const },
      ],
    };
    const question = extractAntigravityUserInputQuestion(request);
    expect(question?.question).toBe(title + "...");
    expect(question?.options).toEqual([{ label: label + "...", description: label + "..." }]);
    expect(
      makeAntigravityUserInputResponse(request, { interaction_9960062f: label + "..." }),
    ).toEqual({ outcome: { outcome: "selected", optionId: "stable-choice" } });
  });
});

describe("Antigravity permissions", () => {
  const mcpRequest = (title: string, rawInput: unknown = {}, kind?: string) =>
    ({
      sessionId: "s",
      toolCall: { toolCallId: "t", title, rawInput, ...(kind ? { kind } : {}) },
      options: [
        { optionId: "always", name: "Allow always", kind: "allow_always" },
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Deny", kind: "reject_once" },
      ],
    }) as EffectAcpSchema.RequestPermissionRequest;

  it("answers Uno Work's own MCP tools once, and nothing else", () => {
    expect(antigravityAutoApprove(mcpRequest("Run mcp_uno-work_show_card?"))).toBe("once");
    expect(
      antigravityAutoApprove(
        mcpRequest("MCP Tool show_card", { ServerName: "uno-work", ToolName: "show_card" }),
      ),
    ).toBe("once");
    expect(
      antigravityAutoApprove(
        mcpRequest("MCP Tool show_card", { ServerName: "other", ToolName: "show_card" }),
      ),
    ).toBeUndefined();
    expect(antigravityAutoApprove(mcpRequest("Run mcp_other_tool?"))).toBeUndefined();
    expect(
      antigravityAutoApprove(mcpRequest("Run mcp_uno-work_x?", { CommandLine: "rm -rf /" })),
    ).toBeUndefined();
    expect(
      antigravityAutoApprove(mcpRequest("Run mcp_uno-work_x?", {}, "execute")),
    ).toBeUndefined();
  });

  it("keeps sessions in agy's default mode", () => {
    expect(antigravityModeFor({ modeState: { availableModeIds: ["default", "auto"] } })).toBe(
      "default",
    );
    expect(antigravityModeFor({ modeState: { availableModeIds: [] } })).toBeUndefined();
  });

  it("keeps /logout out of chats", () => {
    expect(antigravityRefusePrompt("/logout")).toBeDefined();
    expect(antigravityRefusePrompt("log out of the site")).toBeUndefined();
  });
});

const modelConfig = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "gemini-3.8-flash",
  options: [
    { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { value: "gemini-3.8-pro", name: "Gemini 3.8 Pro" },
    { value: "gpt-oss-120b", name: "GPT-OSS 120B" },
  ],
} as unknown as EffectAcpSchema.SessionConfigOption;

const thinkingConfig = {
  id: "thinking",
  name: "Thinking",
  category: "thought_level",
  type: "select",
  currentValue: "medium",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
} as unknown as EffectAcpSchema.SessionConfigOption;

describe("Antigravity model selection", () => {
  const configOptions = [modelConfig, thinkingConfig];

  it("keeps the session's own model for the default pick", () => {
    expect(
      planAntigravityModelSelection({
        configOptions,
        model: "antigravity-default",
        options: undefined,
      }),
    ).toEqual({ ok: true, model: "gemini-3.8-flash", writes: [] });
  });

  it("switches to a listed model, then sets its thinking level", () => {
    expect(
      planAntigravityModelSelection({
        configOptions,
        model: "gemini-3.8-pro",
        options: [{ id: "thinking", value: "high" }],
      }),
    ).toEqual({
      ok: true,
      model: "gemini-3.8-pro",
      writes: [{ configId: "model", value: "gemini-3.8-pro" }],
    });
    expect(
      planAntigravityModelSelection({
        configOptions,
        model: "gemini-3.8-flash",
        options: [{ id: "thinking", value: "high" }],
      }),
    ).toEqual({
      ok: true,
      model: "gemini-3.8-flash",
      writes: [{ configId: "thinking", value: "high" }],
    });
  });

  it("ignores a thinking level the model does not offer", () => {
    expect(
      planAntigravityModelSelection({
        configOptions,
        model: "gemini-3.8-flash",
        options: [{ id: "thinking", value: "max" }],
      }).ok && true,
    ).toBe(true);
    expect(
      planAntigravityModelSelection({
        configOptions,
        model: "gemini-3.8-flash",
        options: [{ id: "thinking", value: "max" }],
      }),
    ).toMatchObject({ writes: [] });
  });

  it("runs a model saved on runtime 1.3 as its family", () => {
    expect(legacyAntigravityFamily(configOptions, "gemini-3.8-flash-low")).toBe("gemini-3.8-flash");
    expect(
      planAntigravityModelSelection({
        configOptions,
        model: "gemini-3.8-pro-high",
        options: undefined,
      }),
    ).toEqual({
      ok: true,
      model: "gemini-3.8-pro",
      writes: [{ configId: "model", value: "gemini-3.8-pro" }],
    });
    expect(
      planAntigravityModelSelection({
        configOptions,
        model: "gemini-3.8-flash-low",
        options: undefined,
      }),
    ).toEqual({ ok: true, model: "gemini-3.8-flash", writes: [] });
  });

  it("refuses a model this account does not have", () => {
    expect(
      planAntigravityModelSelection({ configOptions, model: "claude-opus-9", options: undefined }),
    ).toMatchObject({ ok: false });
  });
});

describe("Antigravity session updates", () => {
  it("turns update_steps into the plan and drops the tool row", () => {
    const transform = makeAntigravitySessionUpdateTransform();
    const result = transform({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "steps-1",
        title: "Run update_steps",
        kind: "other",
        status: "in_progress",
        rawInput: {
          steps: [
            { title: "Read the code", status: "done" },
            { title: "Write the fix", status: "in_progress" },
            { title: "Run tests", status: "todo" },
          ],
        },
      },
    } as EffectAcpSchema.SessionNotification);
    expect(result?.update).toEqual({
      sessionUpdate: "plan",
      entries: [
        { content: "Read the code", priority: "medium", status: "completed" },
        { content: "Write the fix", priority: "medium", status: "in_progress" },
        { content: "Run tests", priority: "medium", status: "pending" },
      ],
    });
    expect(
      transform({
        sessionId: "s",
        update: { sessionUpdate: "tool_call_update", toolCallId: "steps-1", status: "completed" },
      } as EffectAcpSchema.SessionNotification),
    ).toBeUndefined();
  });

  it("fills the command row from agy's native fields and bounds output", () => {
    const transform = makeAntigravitySessionUpdateTransform();
    const result = transform({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "cmd-1",
        title: "run_command",
        kind: "execute",
        status: "in_progress",
        rawInput: { CommandLine: "npm test", Cwd: "/work" },
        rawOutput: { output: "x".repeat(20_000) },
      },
    } as EffectAcpSchema.SessionNotification);
    const update = result?.update as {
      rawInput: Record<string, unknown>;
      rawOutput: { output: string };
    };
    expect(update.rawInput.command).toBe("npm test");
    expect(update.rawInput.cwd).toBe("/work");
    expect(update.rawOutput.output.length).toBeLessThan(8_100);
    expect(update.rawOutput.output.startsWith("[Earlier output truncated]")).toBe(true);
  });

  it("names a subagent call by its role", () => {
    const result = makeAntigravitySessionUpdateTransform()({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "sub-1",
        title: "Running start_subagent",
        kind: "other",
        status: "in_progress",
        rawInput: { Role: "researcher" },
      },
    } as EffectAcpSchema.SessionNotification);
    expect((result?.update as { title?: string } | undefined)?.title).toBe("Subagent: researcher");
  });

  it("drops inline images from tool payloads", () => {
    expect(
      sanitizeAntigravityToolPayload({
        content: [
          { type: "image", data: "AAAA", mimeType: "image/png", uri: "file:///shot.png" },
          { type: "text", text: "data:image/png;base64,AAAA" },
          { type: "text", text: "ok" },
        ],
      }),
    ).toEqual({
      content: [
        { type: "image", mimeType: "image/png", uri: "file:///shot.png" },
        { type: "text" },
        { type: "text", text: "ok" },
      ],
    });
  });

  it("lets a running command or a scheduled wake outlive the turn", () => {
    expect(
      antigravityToolOutlivesPrompt({
        toolCallId: "a",
        kind: "execute",
        data: { rawInput: { CommandLine: "npm run dev" } },
      }),
    ).toBe(true);
    expect(
      antigravityToolOutlivesPrompt({
        toolCallId: "a",
        kind: "execute",
        data: { rawInput: { CommandLine: "npm run dev", IsDaemon: true } },
      }),
    ).toBe(false);
    expect(antigravityToolOutlivesPrompt({ toolCallId: "b", kind: "read", data: {} })).toBe(false);
  });
});
