import { describe, expect, it } from "vitest";

import { envValues, isSecretLookingValue, SCRUBBED, scrubSecrets } from "./scrub.logic.ts";

describe("scrubSecrets", () => {
  it("takes out this project's key values wherever they are", () => {
    const known = envValues(
      [
        "# keys",
        "STRIPE_KEY=rk_9f8e7d6c5b4a",
        'DATABASE_URL="postgres://app:Hunter2Hunter2@db.internal:5432/app"',
        "export ADMIN_PASSWORD='p4ss-w0rd!'",
        "NODE_ENV=production",
        "PORT=3000",
        "DEBUG=true",
      ].join("\n"),
    );
    expect(known).toEqual([
      "rk_9f8e7d6c5b4a",
      "postgres://app:Hunter2Hunter2@db.internal:5432/app",
      "p4ss-w0rd!",
    ]);
    const result = scrubSecrets(
      "Connect with postgres://app:Hunter2Hunter2@db.internal:5432/app, log in with p4ss-w0rd! — NODE_ENV is production on port 3000.",
      known,
    );
    expect(result.text).toBe(
      `Connect with ${SCRUBBED}, log in with ${SCRUBBED} — NODE_ENV is production on port 3000.`,
    );
    expect(result.removed).toBe(2);
  });

  it.each([
    ["an OpenAI key", "use sk-proj-abcdefghijklmnop1234 here"],
    ["an Anthropic key", "key sk-ant-api03-AAAABBBBCCCCDDDD"],
    ["a GitHub token", "ghp_abcdefghijklmnopqrstuvwx12345"],
    ["a fine-grained GitHub token", "github_pat_11ABCDEFG0123456789_abcdef"],
    ["a Slack token", "xoxb-1234567890-abcdefghij"],
    ["an AWS key id", "AKIAIOSFODNN7EXAMPLE"],
    ["an Uno key", "uno_live_0123456789abcdef"],
    ["the Uno AI key", "unollm_0123456789abcdef"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"],
    ["a Telegram bot token", "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ"],
  ])("takes out %s", (_what, text) => {
    const result = scrubSecrets(text);
    expect(result.removed).toBeGreaterThan(0);
    expect(result.text).toContain(SCRUBBED);
    expect(result.text).not.toMatch(/[A-Za-z0-9]{16,}/);
  });

  it("takes out a private key block", () => {
    const text = [
      "Here it is:",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ",
      "-----END OPENSSH PRIVATE KEY-----",
      "done",
    ].join("\n");
    expect(scrubSecrets(text).text).toBe(`Here it is:\n${SCRUBBED}\ndone`);
  });

  it("keeps the name of an assignment, takes its value", () => {
    expect(scrubSecrets("curl -H 'Authorization: Bearer abcdefghijklmnop12345'").text).toBe(
      `curl -H 'Authorization: Bearer ${SCRUBBED}'`,
    );
    expect(scrubSecrets("https://api.example.com/?token=abc123def456&x=1").text).toBe(
      `https://api.example.com/?token=${SCRUBBED}&x=1`,
    );
    expect(scrubSecrets('{"api_key": "zz9-plural-z-alpha"}').text).toBe(
      `{"api_key": "${SCRUBBED}"}`,
    );
    expect(scrubSecrets("DB_PASSWORD=correct-horse-battery").text).toBe(
      `DB_PASSWORD=${SCRUBBED}`,
    );
  });

  it("leaves ordinary text alone", () => {
    const text =
      "I changed the order form: the button is blue now, tests pass (12 of 12). See src/order.ts line 40. The token count is fine.";
    expect(scrubSecrets(text)).toEqual({ text, removed: 0 });
  });

  it("does not count a token twice", () => {
    const result = scrubSecrets("token=ghp_abcdefghijklmnopqrstuvwx12345");
    expect(result.text).toBe(`token=${SCRUBBED}`);
    expect(result.removed).toBe(1);
  });
});

describe("isSecretLookingValue", () => {
  it.each(["production", "3000", "true", "https://example.com/app", "./data", "short1"])(
    "%s is not looked for",
    (value) => expect(isSecretLookingValue(value)).toBe(false),
  );
  it.each(["s3cr3t-value", "abcdefghijklmnopqrst", "Hunter2Hunter2"])("%s is", (value) =>
    expect(isSecretLookingValue(value)).toBe(true),
  );
});
