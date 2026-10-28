import { describe, expect, it } from "vitest";

import {
  chatgptPlanLabel,
  claudePlanLabel,
  claudeUsageWindows,
  codexUsage,
  jwtClaims,
  parseClaudeConfig,
  parseClaudeCredentials,
  parseCodexAuth,
} from "./planLimitsParse.ts";

const NOW = Date.parse("2026-10-28T18:47:14Z");

const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
    JSON.stringify(claims),
  ).toString("base64url")}.sig`;

// Shaped like the answer of 28.10.2026 (Max 20x, trimmed: the many null
// keyed slots, the 7-day breakdown).
const claudeNow = {
  five_hour: { utilization: 50, resets_at: "2026-10-28T21:19:59.948362+00:00" },
  seven_day: { utilization: 54, resets_at: "2026-10-29T10:59:59.948381+00:00" },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  iguana_necktie: {
    utilization: 52.75936840000001,
    resets_at: "2026-11-05T07:59:00+00:00",
    limit_dollars: 250,
    used_dollars: 131.898421,
  },
  extra_usage: {
    is_enabled: false,
    monthly_limit: 15000,
    used_credits: 553,
    utilization: 3.6866666666666665,
    currency: "USD",
    decimal_places: 2,
    disabled_reason: "out_of_credits",
  },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 50,
      severity: "normal",
      resets_at: "2026-10-28T21:19:59.948362+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 54,
      severity: "normal",
      resets_at: "2026-10-29T10:59:59.948381+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 71,
      severity: "normal",
      resets_at: "2026-10-29T10:59:59.948519+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: true,
    },
  ],
  spend: {
    used: { amount_minor: 553, currency: "USD", exponent: 2 },
    limit: { amount_minor: 15000, currency: "USD", exponent: 2 },
    percent: 4,
    enabled: false,
    disabled_reason: "out_of_credits",
  },
  member_dashboard_available: false,
};

// Shaped like the ChatGPT Free answer of 28.10.2026.
const chatgptFree = {
  user_id: "user-x",
  account_id: "995b025c-8ba5-4c50-a443-2fb3403cdb79",
  email: "kate@example.com",
  plan_type: "free",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 7,
      limit_window_seconds: 2592000,
      reset_after_seconds: 1675157,
      reset_at: 1794888396,
    },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  additional_rate_limits: null,
  credits: { has_credits: false, unlimited: false, balance: null },
};

const chatgptPlus = {
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 23,
      limit_window_seconds: 18000,
      reset_after_seconds: 3600,
      reset_at: 1793220434,
    },
    secondary_window: {
      used_percent: 61.5,
      limit_window_seconds: 604800,
      reset_after_seconds: 200000,
      reset_at: 1793416834,
    },
  },
  code_review_rate_limit: {
    primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1793416834 },
  },
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      rate_limit: {
        primary_window: { used_percent: 4, limit_window_seconds: 18000, reset_at: 1793220434 },
        secondary_window: { used_percent: 12, limit_window_seconds: 604800 },
      },
    },
  ],
};

describe("claudeUsageWindows", () => {
  it("reads the limits array: session, week and the per-model week", () => {
    expect(claudeUsageWindows(claudeNow)).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 50,
        windowDurationMins: 300,
        resetsAt: "2026-10-28T21:19:59.948Z",
      },
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 54,
        windowDurationMins: 10080,
        resetsAt: "2026-10-29T10:59:59.948Z",
      },
      {
        id: "seven_day_fable",
        kind: "weekly",
        label: "Weekly · Fable",
        usedPercent: 71,
        windowDurationMins: 10080,
        scope: "Fable",
        resetsAt: "2026-10-29T10:59:59.948Z",
      },
    ]);
  });

  it("falls back to the keyed windows when there is no limits array", () => {
    const { limits: _limits, ...older } = claudeNow;
    const windows = claudeUsageWindows({
      ...older,
      seven_day_opus: { utilization: 12.5, resets_at: "2026-10-29T10:59:59Z" },
    });
    expect(windows?.map((w) => [w.id, w.label, w.usedPercent])).toEqual([
      ["five_hour", "Session", 50],
      ["seven_day", "Weekly", 54],
      ["seven_day_opus", "Weekly · Opus", 12.5],
    ]);
  });

  it("reads the SDK's named per-model weeks", () => {
    const windows = claudeUsageWindows({
      five_hour: { utilization: 1 },
      model_scoped: [{ display_name: "Sonnet 5", utilization: 33 }, { utilization: 2 }],
    });
    expect(windows?.map((w) => w.id)).toEqual(["five_hour", "seven_day_sonnet_5"]);
    expect(windows?.[1]).toMatchObject({ scope: "Sonnet 5", label: "Weekly · Sonnet 5" });
  });

  it("adds extra usage only when it is on", () => {
    expect(claudeUsageWindows(claudeNow)?.some((w) => w.id === "monthly_spend")).toBe(false);
    const on = claudeUsageWindows({ ...claudeNow, spend: { ...claudeNow.spend, enabled: true } });
    expect(on?.find((w) => w.id === "monthly_spend")).toEqual({
      id: "monthly_spend",
      kind: "monthly",
      label: "Monthly spend",
      usedPercent: (553 / 15000) * 100,
    });
    const { spend: _spend, ...noSpend } = claudeNow;
    const extra = claudeUsageWindows({
      ...noSpend,
      extra_usage: { ...claudeNow.extra_usage, is_enabled: true },
    });
    expect(extra?.find((w) => w.id === "monthly_spend")?.usedPercent).toBeCloseTo(3.6867, 3);
  });

  it("files a kind it doesn't know under its group and clamps percentages", () => {
    const windows = claudeUsageWindows({
      limits: [
        { kind: "session", percent: 130 },
        { kind: "daily_all", group: "session", percent: 5 },
        { kind: "weekly_scoped", percent: 9, scope: null },
        { kind: "weekly_all", percent: "lots" },
      ],
    });
    expect(windows).toEqual([
      { id: "daily_all", kind: "session", label: "Daily All", usedPercent: 5 },
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 100,
        windowDurationMins: 300,
      },
    ]);
  });

  it("is null for an answer it can't read", () => {
    expect(claudeUsageWindows(null)).toBeNull();
    expect(claudeUsageWindows([])).toBeNull();
    expect(claudeUsageWindows({ error: { type: "not_found" } })).toBeNull();
    // A readable answer with nothing used yet is not a failure.
    expect(claudeUsageWindows({ five_hour: null, limits: [] })).toEqual([]);
  });
});

describe("codexUsage", () => {
  it("reads a Free plan's single monthly window", () => {
    expect(codexUsage(chatgptFree, NOW)).toEqual({
      planType: "free",
      email: "kate@example.com",
      windows: [
        {
          id: "primary",
          kind: "monthly",
          label: "Monthly",
          usedPercent: 7,
          windowDurationMins: 43200,
          resetsAt: new Date(1794888396 * 1000).toISOString(),
        },
      ],
    });
  });

  it("reads 5 hours and a week, the per-model limits, and skips code review", () => {
    const usage = codexUsage(chatgptPlus, NOW);
    expect(usage?.planType).toBe("plus");
    expect(usage?.windows.map((w) => [w.id, w.kind, w.label, w.usedPercent])).toEqual([
      ["primary", "session", "Session", 23],
      ["secondary", "weekly", "Weekly", 61.5],
      ["gpt_5_3_codex_spark_primary", "session", "Session · GPT-5.3-Codex-Spark", 4],
      ["gpt_5_3_codex_spark_secondary", "weekly", "Weekly · GPT-5.3-Codex-Spark", 12],
    ]);
    expect(usage?.windows[0]?.resetsAt).toBe(new Date(1793220434 * 1000).toISOString());
    // No reset_at: from the seconds left.
    expect(
      codexUsage(
        { rate_limit: { primary_window: { used_percent: 1, reset_after_seconds: 60 } } },
        NOW,
      )?.windows[0],
    ).toMatchObject({
      kind: "session",
      windowDurationMins: 300,
      resetsAt: new Date(NOW + 60_000).toISOString(),
    });
  });

  it("is null for an answer it can't read", () => {
    expect(codexUsage(null, NOW)).toBeNull();
    expect(codexUsage({ detail: "Unauthorized" }, NOW)).toBeNull();
    expect(codexUsage({ rate_limit: null }, NOW)).toEqual({
      windows: [],
      planType: undefined,
      email: undefined,
    });
  });
});

describe("plan labels", () => {
  it("names Claude plans", () => {
    expect(claudePlanLabel("max", "default_claude_max_20x")).toBe("Max 20x");
    expect(claudePlanLabel("max", undefined)).toBe("Max");
    expect(claudePlanLabel(undefined, "default_claude_max_5x")).toBe("Max 5x");
    expect(claudePlanLabel("pro", undefined)).toBe("Pro");
    expect(claudePlanLabel("team", "default_raven")).toBe("Team");
    expect(claudePlanLabel(undefined, undefined)).toBeUndefined();
  });

  it("names ChatGPT plans", () => {
    expect(chatgptPlanLabel("plus")).toBe("Plus");
    expect(chatgptPlanLabel("PRO")).toBe("Pro");
    expect(chatgptPlanLabel("self_serve_business_usage_based")).toBe(
      "Self Serve Business Usage Based",
    );
    expect(chatgptPlanLabel(undefined)).toBeUndefined();
  });
});

describe("sign-in files", () => {
  it("reads Claude Code's credentials and config", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-secret",
        refreshToken: "sk-ant-ort01-secret",
        expiresAt: NOW + 3_600_000,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    });
    expect(parseClaudeCredentials(raw)).toEqual({
      accessToken: "sk-ant-oat01-secret",
      expiresAt: NOW + 3_600_000,
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    });
    // An API-key setup, a broken file, no file.
    expect(parseClaudeCredentials(JSON.stringify({ primaryApiKey: "sk-ant-api" }))).toBeNull();
    expect(parseClaudeCredentials("{")).toBeNull();
    expect(parseClaudeCredentials(null)).toBeNull();

    expect(
      parseClaudeConfig(
        JSON.stringify({
          numStartups: 3,
          oauthAccount: {
            emailAddress: "misha@example.com",
            organizationRateLimitTier: "default_claude_max_20x",
          },
        }),
      ),
    ).toEqual({ email: "misha@example.com", rateLimitTier: "default_claude_max_20x" });
    expect(parseClaudeConfig(null)).toEqual({ email: undefined, rateLimitTier: undefined });
  });

  it("reads Codex's ChatGPT sign-in from the tokens and their claims", () => {
    const access = jwt({ exp: NOW / 1000 + 600 });
    const raw = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt({
          email: "misha@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc-from-claim",
            chatgpt_plan_type: "pro",
          },
        }),
        access_token: access,
        refresh_token: "rt-secret",
      },
      last_refresh: "2026-10-28T10:00:00Z",
    });
    expect(parseCodexAuth(raw)).toEqual({
      accessToken: access,
      accountId: "acc-from-claim",
      email: "misha@example.com",
      planType: "pro",
      expiresAt: NOW + 600_000,
    });
    // An API key alone has no plan limits.
    expect(parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-x", tokens: null }))).toBeNull();
    expect(parseCodexAuth("not json")).toBeNull();
    expect(jwtClaims("opaque-token")).toBeNull();
  });
});
