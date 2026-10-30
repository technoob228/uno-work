import { describe, expect, it } from "vitest";

import { buildFixWorkContext, redactForSupport } from "./fixWorkReport.ts";

describe("redactForSupport", () => {
  it.each([
    ["OPENAI_API_KEY=abcd1234efgh", "OPENAI_API_KEY=[redacted]"],
    ['{"password": "hunter2hunter"}', '{"password": [redacted]}'],
    ["Authorization: Bearer abcdefgh12345678", "Authorization: [redacted]"],
    ["cookie: a=1; b=2", "cookie: [redacted]"],
    ["got Bearer abcdefgh12345678 back", "got Bearer [redacted] back"],
    ["curl https://me:s3cret@host.example/x", "curl https://me:[redacted]@host.example/x"],
  ])("takes the value out of %s", (input, output) => {
    const result = redactForSupport(input);
    expect(result.text).toBe(output);
    expect(result.count).toBeGreaterThan(0);
  });

  it.each([
    "sk-ant-abcdefghijklmnopqrstuvwxyz",
    "sk-abcdefghijklmnopqrstuvwxyz012345",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-123456789012-abcdefghijkl",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijkl",
  ])("removes %s", (secret) => {
    expect(redactForSupport(`seen ${secret} in the log`).text).not.toContain(secret);
  });

  it("removes a private key whole", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
    expect(redactForSupport(`key:\n${pem}\ndone`).text).toBe("key:\n[redacted]\ndone");
  });

  it("removes a long opaque string but keeps what a reader needs", () => {
    const opaque = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A0";
    expect(redactForSupport(`blob ${opaque}`).text).toBe("blob [redacted]");
    const plain =
      "Claude 2.1.284 stopped at 12:03 in /var/lib/uno-work with 62edd3b3d3f0a1b2c3d4e5f60718293a4b5c6d7e";
    expect(redactForSupport(plain)).toEqual({ text: plain, count: 0 });
  });
});

describe("buildFixWorkContext", () => {
  it("lists the machine and its agents, with no secret in a message", () => {
    const text = buildFixWorkContext({
      generatedAt: "2026-10-30T12:00:00.000Z",
      version: "0.0.168",
      platform: "linux 6.8 x64",
      mode: "web",
      host: "stage-work",
      memory: { freeMb: 512, totalMb: 2048 },
      disk: { freeGb: 3, totalGb: 40 },
      uptimeHours: 12,
      paths: { daemonFolder: "/var/lib/uno-work", workspace: "/home/unowork/projects" },
      openCodeVersion: "1.18.32",
      agents: [
        {
          name: "Claude",
          version: "2.1.284",
          status: "error",
          signedIn: "unauthenticated",
          message: "token=abcdefgh12345678 expired",
        },
      ],
    });
    expect(text).toContain("Uno Work 0.0.168 (web) on stage-work");
    expect(text).toContain("3 GB free of 40 GB");
    expect(text).toContain("Claude: 2.1.284");
    expect(text).not.toContain("abcdefgh12345678");
  });
});
