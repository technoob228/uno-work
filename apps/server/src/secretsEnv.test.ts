import { describe, expect, it } from "vitest";

import {
  formatEnvValue,
  isValidSecretName,
  isValidSecretTargetFile,
  resolveSecretTargetDirectory,
  upsertEnvContent,
} from "./secretsEnv.ts";

describe("isValidSecretName", () => {
  it("accepts env-style names", () => {
    expect(isValidSecretName("OPENAI_API_KEY")).toBe(true);
    expect(isValidSecretName("_private")).toBe(true);
    expect(isValidSecretName("db2Password")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isValidSecretName("")).toBe(false);
    expect(isValidSecretName("2FA_CODE")).toBe(false);
    expect(isValidSecretName("MY KEY")).toBe(false);
    expect(isValidSecretName("KEY=VALUE")).toBe(false);
    expect(isValidSecretName("A".repeat(129))).toBe(false);
    expect(isValidSecretName(42)).toBe(false);
  });
});

describe("isValidSecretTargetFile", () => {
  it("accepts dotenv-style names", () => {
    expect(isValidSecretTargetFile(".env")).toBe(true);
    expect(isValidSecretTargetFile(".env.local")).toBe(true);
    expect(isValidSecretTargetFile(".env.production")).toBe(true);
  });

  it("rejects paths and arbitrary files", () => {
    expect(isValidSecretTargetFile("env")).toBe(false);
    expect(isValidSecretTargetFile("../.env")).toBe(false);
    expect(isValidSecretTargetFile(".env/../../etc/passwd")).toBe(false);
    expect(isValidSecretTargetFile("config.json")).toBe(false);
    expect(isValidSecretTargetFile(".env.")).toBe(false);
  });
});

describe("formatEnvValue", () => {
  it("keeps plain tokens raw", () => {
    expect(formatEnvValue("sk-abc123")).toBe("sk-abc123");
    expect(formatEnvValue("postgres://u:p@host/db")).toBe("postgres://u:p@host/db");
  });

  it("quotes values with spaces, quotes and newlines", () => {
    expect(formatEnvValue("hello world")).toBe('"hello world"');
    expect(formatEnvValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(formatEnvValue("line1\nline2")).toBe('"line1\\nline2"');
    expect(formatEnvValue("back\\slash")).toBe('"back\\\\slash"');
  });
});

describe("upsertEnvContent", () => {
  it("appends to empty content", () => {
    expect(upsertEnvContent("", "KEY", "value")).toBe("KEY=value\n");
  });

  it("appends after existing lines without extra blank lines", () => {
    expect(upsertEnvContent("A=1\n\n\n", "KEY", "v")).toBe("A=1\nKEY=v\n");
  });

  it("replaces an existing assignment in place", () => {
    expect(upsertEnvContent("A=1\nKEY=old\nB=2\n", "KEY", "new")).toBe("A=1\nKEY=new\nB=2\n");
  });

  it("replaces export-style assignments", () => {
    expect(upsertEnvContent("export KEY=old\n", "KEY", "new")).toBe("KEY=new\n");
  });

  it("does not touch commented or prefixed names", () => {
    expect(upsertEnvContent("# KEY=old\nKEY_SUFFIX=x\n", "KEY", "v")).toBe(
      "# KEY=old\nKEY_SUFFIX=x\nKEY=v\n",
    );
  });

  it("quotes special values on the way in", () => {
    expect(upsertEnvContent("", "KEY", "a b")).toBe('KEY="a b"\n');
  });
});

describe("secret target directory", () => {
  const threadCwd = "/Users/dev/projects/api";

  it("accepts the thread's own folder", () => {
    expect(resolveSecretTargetDirectory({ threadCwd, requestedCwd: threadCwd })).toEqual({
      ok: true,
      cwd: threadCwd,
    });
  });

  it("accepts a folder inside it", () => {
    expect(
      resolveSecretTargetDirectory({ threadCwd, requestedCwd: `${threadCwd}/services/worker` }),
    ).toEqual({ ok: true, cwd: `${threadCwd}/services/worker` });
  });

  it("refuses a sibling project", () => {
    // The agent picks `cwd` itself; without this check it could drop a .env
    // into any project on the machine.
    expect(
      resolveSecretTargetDirectory({ threadCwd, requestedCwd: "/Users/dev/projects/billing" }).ok,
    ).toBe(false);
  });

  it("refuses an escape through ..", () => {
    expect(
      resolveSecretTargetDirectory({ threadCwd, requestedCwd: `${threadCwd}/../billing` }).ok,
    ).toBe(false);
    expect(resolveSecretTargetDirectory({ threadCwd, requestedCwd: "/etc" }).ok).toBe(false);
  });

  it("does not mistake a name prefix for a subfolder", () => {
    expect(
      resolveSecretTargetDirectory({ threadCwd, requestedCwd: "/Users/dev/projects/api-old" }).ok,
    ).toBe(false);
  });

  it("keeps the old behaviour when the thread has no folder", () => {
    expect(
      resolveSecretTargetDirectory({ threadCwd: undefined, requestedCwd: "/tmp/anywhere" }),
    ).toEqual({ ok: true, cwd: "/tmp/anywhere" });
  });
});
