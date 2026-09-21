import { afterEach, describe, expect, it } from "vitest";

import {
  isInheritableHarnessEnv,
  redactSecretsDeep,
  redactSecretsInText,
  registerKnownSecret,
  resetKnownSecretsForTest,
} from "./secretRedaction.ts";
import {
  mergeProviderInstanceEnvironment,
  sanitizeInheritedHarnessEnvironment,
} from "./provider/ProviderInstanceEnvironment.ts";

const BOX_TOKEN = "uno_agt_Zk3q9XbLr0aQwErTyUiOp12";
const GATEWAY_KEY = "unollm_AbCdEf0123456789xyzXYZ";
const ACCOUNT_KEY = "uno_usr_q1w2e3r4t5y6u7i8o9p0";

afterEach(() => resetKnownSecretsForTest());

describe("redactSecretsInText", () => {
  it("masks Uno tokens by prefix and keeps the prefix readable", () => {
    const text = `{"uno":{"apiKey":"${GATEWAY_KEY}","boxToken":"${BOX_TOKEN}"}}\nUNO_API_KEY=${ACCOUNT_KEY}`;
    const out = redactSecretsInText(text);
    expect(out).not.toContain(GATEWAY_KEY);
    expect(out).not.toContain(BOX_TOKEN);
    expect(out).not.toContain(ACCOUNT_KEY);
    expect(out).toContain("unollm_[redacted]");
    expect(out).toContain("uno_agt_[redacted]");
    expect(out).toContain("uno_usr_[redacted]");
  });

  it("masks every Uno and common third-party format", () => {
    for (const secret of [
      "uno_box_0123456789abcdefABCD",
      "uno_gpu_0123456789abcdefABCD",
      "unor_0123456789abcdefABCD",
      "sk-ant-api03-0123456789abcdefABCDEF",
      "sk-or-v1-0123456789abcdef0123456789",
      "ghp_0123456789abcdefABCDEF0123456789",
    ]) {
      expect(redactSecretsInText(`token: ${secret} end`)).not.toContain(secret);
    }
  });

  it("does not touch ordinary text or short prefixes", () => {
    for (const text of [
      "Show me what you can do",
      "set uno_agt_ in settings",
      "variable UNO_AGENT_API_KEY is set",
      "unollm_short",
    ]) {
      expect(redactSecretsInText(text)).toBe(text);
    }
  });

  it("masks known secrets without a prefix (legacy account key, bridge token)", () => {
    const legacy = "sNIhA7fK2pQ9xW4mZ1bC";
    const bridge = "a".repeat(8) + "0123456789abcdef0123456789abcdef0123456789";
    registerKnownSecret(legacy);
    registerKnownSecret(bridge);
    registerKnownSecret("short");
    const out = redactSecretsInText(`key=${legacy} bridge=${bridge} word=short`);
    expect(out).toBe("key=[redacted] bridge=[redacted] word=short");
  });
});

describe("redactSecretsDeep", () => {
  it("masks nested tool output and returns untouched branches by reference", () => {
    const clean = { tool: "bash", title: "ls" };
    const event = {
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        data: { clean, state: { output: `UNO_AGENT_API_KEY=${BOX_TOKEN}\n` } },
      },
      raw: [{ text: `apiKey ${GATEWAY_KEY}` }],
    };
    const out = redactSecretsDeep(event);
    expect(JSON.stringify(out)).not.toContain(BOX_TOKEN);
    expect(JSON.stringify(out)).not.toContain(GATEWAY_KEY);
    expect(out.payload.data.clean).toBe(clean);
    expect(event.payload.data.state.output).toContain(BOX_TOKEN); // вход не мутируем
  });

  it("returns the same object when nothing to mask", () => {
    const event = { type: "content.delta", payload: { delta: "hello" } };
    expect(redactSecretsDeep(event)).toBe(event);
  });
});

describe("harness environment", () => {
  it("drops inherited Uno secrets but keeps third-party keys and ordinary vars", () => {
    registerKnownSecret("sNIhA7fK2pQ9xW4mZ1bC");
    const env = sanitizeInheritedHarnessEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/unowork",
      UNO_WORK_API_KEY: "whatever",
      SOME_TOKEN: BOX_TOKEN,
      LEGACY: "sNIhA7fK2pQ9xW4mZ1bC",
      ANTHROPIC_API_KEY: "sk-ant-api03-0123456789abcdefABCDEF",
      UNO_API_URL: "https://console.uno4.dev",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/unowork",
      ANTHROPIC_API_KEY: "sk-ant-api03-0123456789abcdefABCDEF",
      UNO_API_URL: "https://console.uno4.dev",
    });
    expect(isInheritableHarnessEnv("UNO_BOX_TOKEN", "")).toBe(false);
  });

  it("keeps instance variables the owner configured explicitly", () => {
    const env = mergeProviderInstanceEnvironment(
      [{ name: "UNO_API_KEY", value: GATEWAY_KEY, sensitive: true }],
      { PATH: "/usr/bin", LEAKED: BOX_TOKEN },
    );
    expect(env).toEqual({ PATH: "/usr/bin", UNO_API_KEY: GATEWAY_KEY });
  });

  it("returns the base env untouched when there is nothing to drop", () => {
    const base = { PATH: "/usr/bin" };
    expect(sanitizeInheritedHarnessEnvironment(base)).toBe(base);
  });
});
