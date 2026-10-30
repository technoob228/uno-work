import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CHATGPT_USAGE_URL,
  CLAUDE_USAGE_URL,
  claudeKeychainService,
  makeMacClaudeKeychain,
  openPlanLimitsReader,
  PLAN_LIMITS_MAX_AGE_MS,
  planLimitsHomes,
  type ClaudeKeychain,
  type PlanLimitsHomes,
} from "./planLimitsReader.ts";

const T0 = Date.parse("2026-10-28T18:00:00Z");
const CLAUDE_TOKEN = "sk-ant-oat01-SECRET-claude";
const HOMES: PlanLimitsHomes = {
  claudeHome: "/home/unowork",
  claudeConfigDir: "/home/unowork/.claude",
  codexHome: "/home/unowork/.codex",
};

const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
    JSON.stringify(claims),
  ).toString("base64url")}.sig`;
const CODEX_TOKEN = jwt({ exp: T0 / 1000 + 3600, secret: "SECRET-codex" });

const claudeCredentials = (expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: CLAUDE_TOKEN,
      refreshToken: "sk-ant-ort01-SECRET-refresh",
      expiresAt,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
  });
const claudeConfig = JSON.stringify({ oauthAccount: { emailAddress: "misha@example.com" } });
const codexAuth = JSON.stringify({
  tokens: {
    id_token: jwt({
      email: "misha@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acc-1", chatgpt_plan_type: "plus" },
    }),
    access_token: CODEX_TOKEN,
    refresh_token: "rt-SECRET",
  },
});

const claudeAnswer = {
  five_hour: { utilization: 50, resets_at: "2026-10-28T21:00:00Z" },
  seven_day: { utilization: 54, resets_at: "2026-10-29T11:00:00Z" },
  limits: [
    { kind: "session", group: "session", percent: 50, resets_at: "2026-10-28T21:00:00Z" },
    { kind: "weekly_all", group: "weekly", percent: 54, resets_at: "2026-10-29T11:00:00Z" },
  ],
};
const codexAnswer = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 23, limit_window_seconds: 18000, reset_at: T0 / 1000 + 600 },
    secondary_window: { used_percent: 61, limit_window_seconds: 604800, reset_at: T0 / 1000 + 9e4 },
  },
};

type Answer = { readonly status: number; readonly body: unknown } | "offline";

async function setup(input: {
  readonly files?: Record<string, string>;
  readonly keychain?: ClaudeKeychain | null;
  readonly claude?: Answer;
  readonly chatgpt?: Answer;
  readonly cacheFile?: string;
}) {
  const files = new Map(Object.entries(input.files ?? {}));
  let clock = T0;
  const answers: Record<string, Answer> = {
    [CLAUDE_USAGE_URL]: input.claude ?? { status: 200, body: claudeAnswer },
    [CHATGPT_USAGE_URL]: input.chatgpt ?? { status: 200, body: codexAnswer },
  };
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    const answer = answers[url];
    if (!answer || answer === "offline") throw new TypeError("fetch failed");
    return new Response(
      typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
      { status: answer.status },
    );
  });
  const cacheFile =
    input.cacheFile ??
    path.join(await mkdtemp(path.join(os.tmpdir(), "plan-limits-")), "plan-limits.json");
  const reader = await openPlanLimitsReader({
    cacheFile,
    keychain: input.keychain ?? null,
    readText: async (file) => files.get(file) ?? null,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => clock,
  });
  return {
    reader,
    fetch,
    files,
    answers,
    cacheFile,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const signedIn = {
  "/home/unowork/.claude/.credentials.json": claudeCredentials(T0 + 3_600_000),
  "/home/unowork/.claude.json": claudeConfig,
  "/home/unowork/.codex/auth.json": codexAuth,
};

describe("openPlanLimitsReader", () => {
  it("has no accounts without a sign-in, and asks nobody", async () => {
    const { reader, fetch } = await setup({
      files: { "/home/unowork/.claude/.credentials.json": '{"primaryApiKey":"sk-ant-api"}' },
    });
    expect(await reader.read({ homes: HOMES })).toEqual({ accounts: [] });
    expect(await reader.read({ homes: HOMES, signInsOnly: true })).toEqual({ accounts: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads both plans, each token only to its own endpoint", async () => {
    const { reader, fetch } = await setup({ files: signedIn });
    const result = await reader.read({ homes: HOMES });
    expect(result.accounts).toEqual([
      {
        id: "claude:misha@example.com",
        provider: "claude",
        plan: "Max 20x",
        email: "misha@example.com",
        windows: [
          expect.objectContaining({ id: "five_hour", usedPercent: 50 }),
          expect.objectContaining({ id: "seven_day", usedPercent: 54 }),
        ],
        checkedAt: new Date(T0).toISOString(),
      },
      {
        id: "chatgpt:misha@example.com",
        provider: "chatgpt",
        plan: "Plus",
        email: "misha@example.com",
        windows: [
          expect.objectContaining({ id: "primary", kind: "session", usedPercent: 23 }),
          expect.objectContaining({ id: "secondary", kind: "weekly", usedPercent: 61 }),
        ],
        checkedAt: new Date(T0).toISOString(),
      },
    ]);
    const headersFor = (url: string) =>
      new Headers(fetch.mock.calls.find(([called]) => called === url)?.[1]?.headers);
    expect(headersFor(CLAUDE_USAGE_URL).get("authorization")).toBe(`Bearer ${CLAUDE_TOKEN}`);
    expect(headersFor(CLAUDE_USAGE_URL).get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(headersFor(CHATGPT_USAGE_URL).get("authorization")).toBe(`Bearer ${CODEX_TOKEN}`);
    expect(headersFor(CHATGPT_USAGE_URL).get("chatgpt-account-id")).toBe("acc-1");
    for (const [, init] of fetch.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toMatch(/SECRET/);
  });

  it("reads again only after five minutes, and once for concurrent callers", async () => {
    const { reader, fetch, advance } = await setup({ files: signedIn });
    await Promise.all([reader.read({ homes: HOMES }), reader.read({ homes: HOMES })]);
    expect(fetch).toHaveBeenCalledTimes(2);
    advance(PLAN_LIMITS_MAX_AGE_MS - 1);
    await reader.read({ homes: HOMES });
    expect(fetch).toHaveBeenCalledTimes(2);
    advance(1);
    await reader.read({ homes: HOMES });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("keeps the last numbers, marked stale, when a read fails", async () => {
    const { reader, answers, advance } = await setup({ files: signedIn });
    await reader.read({ homes: HOMES });
    const cases: Array<[Answer, string]> = [
      [{ status: 500, body: "oops" }, "unreachable"],
      ["offline", "unreachable"],
      [{ status: 401, body: { error: "invalid" } }, "rejected"],
      [{ status: 429, body: {} }, "busy"],
      [{ status: 200, body: "<html>" }, "unexpected"],
      [{ status: 200, body: { error: "nope" } }, "unexpected"],
    ];
    for (const [answer, problem] of cases) {
      answers[CLAUDE_USAGE_URL] = answer;
      advance(PLAN_LIMITS_MAX_AGE_MS);
      const claude = (await reader.read({ homes: HOMES })).accounts[0];
      expect(claude).toMatchObject({
        stale: true,
        problem,
        checkedAt: new Date(T0).toISOString(),
        windows: [
          { id: "five_hour", usedPercent: 50 },
          { id: "seven_day", usedPercent: 54 },
        ],
      });
    }
    // Recovered: fresh, no marker.
    answers[CLAUDE_USAGE_URL] = { status: 200, body: claudeAnswer };
    advance(PLAN_LIMITS_MAX_AGE_MS);
    const claude = (await reader.read({ homes: HOMES })).accounts[0];
    expect(claude?.stale).toBeUndefined();
    expect(claude?.problem).toBeUndefined();
  });

  it("doesn't use an expired token, and shows numbers from the last run of the daemon", async () => {
    const first = await setup({ files: signedIn });
    await first.reader.read({ homes: HOMES });
    const cache = await readFile(first.cacheFile, "utf8");
    expect(cache).not.toMatch(/SECRET/);
    expect((await stat(first.cacheFile)).mode & 0o777).toBe(0o600);

    const { reader, fetch } = await setup({
      cacheFile: first.cacheFile,
      files: {
        ...signedIn,
        "/home/unowork/.claude/.credentials.json": claudeCredentials(T0 - 1),
      },
    });
    // Before a read: last run's numbers, stale.
    const known = (await reader.read({ homes: HOMES, signInsOnly: true })).accounts;
    expect(known.map((a) => [a.id, a.stale, a.windows.length])).toEqual([
      ["claude:misha@example.com", true, 2],
      ["chatgpt:misha@example.com", true, 2],
    ]);
    expect(fetch).not.toHaveBeenCalled();

    const [claude, chatgpt] = (await reader.read({ homes: HOMES })).accounts;
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([CHATGPT_USAGE_URL]);
    expect(claude).toMatchObject({ stale: true, problem: "expired" });
    expect(claude?.windows).toHaveLength(2);
    expect(chatgpt?.stale).toBeUndefined();
  });

  it("reports a sign-in that was never read without windows", async () => {
    const { reader } = await setup({
      files: { "/home/unowork/.codex/auth.json": codexAuth },
      chatgpt: { status: 403, body: {} },
    });
    expect((await reader.read({ homes: HOMES })).accounts).toEqual([
      {
        id: "chatgpt:misha@example.com",
        provider: "chatgpt",
        plan: "Plus",
        email: "misha@example.com",
        windows: [],
        problem: "rejected",
      },
    ]);
  });

  it("asks the Mac Keychain only when the file has no live sign-in, and only to read numbers", async () => {
    const keychain = {
      exists: vi.fn(async () => true),
      read: vi.fn(async () => ({ raw: claudeCredentials(T0 + 3_600_000), blocked: false })),
    };
    const fresh = await setup({ files: signedIn, keychain });
    await fresh.reader.read({ homes: HOMES });
    expect(keychain.exists).not.toHaveBeenCalled();

    const { reader, fetch } = await setup({
      files: { "/home/unowork/.claude.json": claudeConfig },
      keychain,
    });
    const listed = await reader.read({ homes: HOMES, signInsOnly: true });
    expect(listed.accounts.map((a) => a.id)).toEqual(["claude:misha@example.com"]);
    expect(keychain.read).not.toHaveBeenCalled();
    const read = await reader.read({ homes: HOMES });
    expect(keychain.read).toHaveBeenCalledTimes(1);
    expect(read.accounts[0]).toMatchObject({ plan: "Max 20x", windows: [{}, {}] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("says the Keychain is locked when it doesn't hand the sign-in over", async () => {
    const keychain = {
      exists: vi.fn(async () => true),
      read: vi.fn(async () => ({ raw: null, blocked: true })),
    };
    const { reader, fetch } = await setup({
      files: { "/home/unowork/.claude.json": claudeConfig },
      keychain,
    });
    expect((await reader.read({ homes: HOMES })).accounts).toEqual([
      expect.objectContaining({ provider: "claude", problem: "locked", windows: [] }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("second accounts", () => {
  const folder = "/home/unowork/.uno-accounts/claudeAgent_account_ab12cd34";
  const shadow = "/home/unowork/.uno-accounts/codex_account_ab12cd34";
  const accounts = [
    { instanceId: "claudeAgent_account_ab12cd34", provider: "claude", folder },
    { instanceId: "codex_account_ab12cd34", provider: "chatgpt", folder: shadow },
  ] as const;
  const secondConfig = JSON.stringify({ oauthAccount: { emailAddress: "two@example.com" } });
  const secondCodex = JSON.stringify({
    tokens: {
      id_token: jwt({
        email: "two@example.com",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-2", chatgpt_plan_type: "pro" },
      }),
      access_token: CODEX_TOKEN,
    },
  });

  it("reads each from its own folder and says which instance it is", async () => {
    const { reader, fetch } = await setup({
      files: {
        ...signedIn,
        [`${folder}/.credentials.json`]: claudeCredentials(T0 + 3_600_000),
        [`${folder}/.claude.json`]: secondConfig,
        [`${shadow}/auth.json`]: secondCodex,
      },
    });
    const { accounts: rows } = await reader.read({ homes: { ...HOMES, accounts } });
    expect(rows.map((row) => [row.id, row.instanceId])).toEqual([
      ["claude:misha@example.com", undefined],
      ["chatgpt:misha@example.com", undefined],
      ["claude:two@example.com", "claudeAgent_account_ab12cd34"],
      ["chatgpt:two@example.com", "codex_account_ab12cd34"],
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("shows an account signed in after the last read, without waiting for the cache", async () => {
    const { reader, fetch, files } = await setup({ files: signedIn });
    const homes = { ...HOMES, accounts: [accounts[0]] };
    await reader.read({ homes });
    expect(fetch).toHaveBeenCalledTimes(2);

    // Not signed in yet: the cache holds, nobody asks the provider again.
    await reader.read({ homes });
    expect(fetch).toHaveBeenCalledTimes(2);

    files.set(`${folder}/.credentials.json`, claudeCredentials(T0 + 3_600_000));
    files.set(`${folder}/.claude.json`, secondConfig);
    const { accounts: rows } = await reader.read({ homes });
    expect(rows.map((row) => row.instanceId)).toContain("claudeAgent_account_ab12cd34");
    expect(fetch).toHaveBeenCalledTimes(5);

    await reader.read({ homes });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("doesn't read a second account's email from the main sign-in", async () => {
    const { reader } = await setup({
      files: { ...signedIn, [`${folder}/.credentials.json`]: claudeCredentials(T0 + 3_600_000) },
    });
    const { accounts: rows } = await reader.read({ homes: { ...HOMES, accounts } });
    const second = rows.find((row) => row.instanceId === "claudeAgent_account_ab12cd34");
    expect(second?.id).toBe("claude:claudeAgent_account_ab12cd34");
    expect(second?.email).toBeUndefined();
  });

  it("counts one account signed in twice once, as the main sign-in", async () => {
    const { reader } = await setup({
      files: {
        ...signedIn,
        [`${folder}/.credentials.json`]: claudeCredentials(T0 + 3_600_000),
        [`${folder}/.claude.json`]: claudeConfig,
      },
    });
    const { accounts: rows } = await reader.read({ homes: { ...HOMES, accounts } });
    expect(rows.filter((row) => row.provider === "claude")).toHaveLength(1);
    expect(rows[0]?.instanceId).toBeUndefined();
  });

  it("isn't listed before it signs in", async () => {
    const { reader } = await setup({ files: signedIn });
    const { accounts: rows } = await reader.read({ homes: { ...HOMES, accounts } });
    expect(rows.map((row) => row.instanceId)).toEqual([undefined, undefined]);
  });

  it("shows an account added since the last read, without waiting for the cache", async () => {
    const { reader, files } = await setup({ files: signedIn });
    await reader.read({ homes: HOMES });
    files.set(`${folder}/.credentials.json`, claudeCredentials(T0 + 3_600_000));
    files.set(`${folder}/.claude.json`, secondConfig);
    const { accounts: rows } = await reader.read({ homes: { ...HOMES, accounts } });
    expect(rows.map((row) => row.email)).toContain("two@example.com");
  });

  it("asks the Mac Keychain for the folder's own item, not the main one", async () => {
    const asked: Array<string | undefined> = [];
    const keychain: ClaudeKeychain = {
      exists: async (service) => {
        asked.push(service);
        return service !== undefined;
      },
      read: async (service) => {
        asked.push(service);
        return { raw: claudeCredentials(T0 + 3_600_000), blocked: false };
      },
    };
    const { reader } = await setup({ keychain, files: {} });
    await reader.read({ homes: { ...HOMES, accounts: [accounts[0]] } });
    expect(new Set(asked.filter(Boolean))).toEqual(new Set([claudeKeychainService(folder)]));
  });

  it("names the Keychain item as Claude Code does: sha256 of the folder, 8 hex", () => {
    expect(claudeKeychainService("/a")).toBe("Claude Code-credentials-6a50dc85");
  });

  it("finds them in the settings, skipping switched-off ones and plain instances", () => {
    const providers = {
      claudeAgent: { homePath: "" },
      codex: { homePath: "", shadowHomePath: "" },
    } as never;
    const homes = planLimitsHomes(
      {
        providers,
        providerInstances: {
          claudeAgent_account_a: {
            driver: "claudeAgent",
            environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/f/a", sensitive: false }],
          },
          codex_account_b: { driver: "codex", config: { shadowHomePath: "/f/b" } },
          claudeAgent_account_off: {
            driver: "claudeAgent",
            enabled: false,
            environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/f/off", sensitive: false }],
          },
          codex_plain: { driver: "codex", config: {} },
          opencode_x: { driver: "opencode" },
        },
      } as never,
      "/home/unowork",
      {},
    );
    expect(homes.accounts).toEqual([
      { instanceId: "claudeAgent_account_a", provider: "claude", folder: "/f/a" },
      { instanceId: "codex_account_b", provider: "chatgpt", folder: "/f/b" },
    ]);
  });
});

describe("makeMacClaudeKeychain", () => {
  it("checks attributes only, and stops reading after a read fails or times out", async () => {
    const run = vi.fn(async (args: ReadonlyArray<string>, _timeoutMs: number) =>
      args.includes("-w") ? { ok: false as const } : { ok: true as const, stdout: "keychain: …" },
    );
    const keychain = makeMacClaudeKeychain(run);
    expect(await keychain.exists()).toBe(true);
    expect(run.mock.calls[0]?.[0]).toEqual([
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
    ]);
    expect(await keychain.read()).toEqual({ raw: null, blocked: true });
    expect(run.mock.calls[1]?.[1]).toBeLessThanOrEqual(5_000);
    expect(await keychain.read()).toEqual({ raw: null, blocked: true });
    // Still there, still not asked again.
    expect(await keychain.exists()).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("hands over the item when it answers", async () => {
    const keychain = makeMacClaudeKeychain(async (args) =>
      args.includes("-w") ? { ok: true, stdout: '{"claudeAiOauth":{}}\n' } : { ok: false },
    );
    expect(await keychain.exists()).toBe(false);
    expect(await keychain.read()).toEqual({ raw: '{"claudeAiOauth":{}}', blocked: false });
  });
});
