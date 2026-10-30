import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ServerProvider } from "@t3tools/contracts";
import { UNO_OPENCODE_VERSION } from "@t3tools/shared/agentVersions";
import { beforeEach, describe, expect, it } from "vitest";

import {
  agentUpdateStatuses,
  isNpmManagedPath,
  latestNpmVersion,
  resetAgentUpdatesCacheForTest,
} from "./agentUpdates.ts";

const provider = (driver: string, version: string | null, installed = true) =>
  ({ driver, instanceId: driver, installed, version }) as unknown as ServerProvider;

const npmBin = (bin: string) => `/home/unowork/.local/lib/node_modules/${bin}/bin/${bin}`;

describe("agentUpdateStatuses", () => {
  const deps = { latest: async () => "2.1.300", binPath: npmBin };

  it("says which agents are behind their target", async () => {
    const statuses = await agentUpdateStatuses(
      [provider("claudeAgent", "2.1.284 (Claude Code)"), provider("codex", "codex-cli 2.1.300")],
      deps,
    );
    expect(statuses).toEqual([
      expect.objectContaining({ driver: "claudeAgent", version: "2.1.284", behind: true }),
      expect.objectContaining({ driver: "codex", version: "2.1.300", behind: false }),
    ]);
  });

  it("holds OpenCode at the pin, also when it is ahead of it", async () => {
    const [ahead] = await agentUpdateStatuses([provider("opencode", "9.0.0")], deps);
    expect(ahead).toMatchObject({ target: UNO_OPENCODE_VERSION, behind: false });
    const [older] = await agentUpdateStatuses([provider("opencode", "1.0.0")], deps);
    expect(older).toMatchObject({ target: UNO_OPENCODE_VERSION, behind: true });
  });

  it("leaves an agent npm didn't install alone", async () => {
    const [status] = await agentUpdateStatuses([provider("claudeAgent", "1.0.0")], {
      ...deps,
      binPath: () => "/Users/me/.local/share/claude/versions/1.0.0",
    });
    expect(status).toMatchObject({ managed: false, behind: false });
  });

  it("skips agents that aren't installed, and doesn't guess without an answer", async () => {
    const statuses = await agentUpdateStatuses(
      [provider("codex", null, false), provider("claudeAgent", "1.0.0")],
      { ...deps, latest: async () => null },
    );
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ target: null, behind: false });
  });
});

describe("isNpmManagedPath", () => {
  it("knows npm's folder", () => {
    expect(isNpmManagedPath(npmBin("codex"))).toBe(true);
    expect(isNpmManagedPath("/opt/homebrew/Caskroom/claude-code/1/claude")).toBe(false);
    expect(isNpmManagedPath(null)).toBe(false);
  });
});

describe("latestNpmVersion", () => {
  beforeEach(resetAgentUpdatesCacheForTest);

  it("asks once in half an hour", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: "2.1.300" }));
    };
    let now = 0;
    const options = { fetch, now: () => now };
    expect(await latestNpmVersion("@openai/codex", options)).toBe("2.1.300");
    expect(await latestNpmVersion("@openai/codex", options)).toBe("2.1.300");
    expect(calls).toBe(1);
    now = 31 * 60_000;
    await latestNpmVersion("@openai/codex", options);
    expect(calls).toBe(2);
  });

  it("gives null when the registry doesn't answer", async () => {
    const fetch = async () => {
      throw new Error("offline");
    };
    expect(await latestNpmVersion("opencode-ai", { fetch })).toBeNull();
  });
});

describe("the OpenCode pin", () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  it("is the same in the image, the desktop app and the agent list", () => {
    expect(read("../../../deploy/install.sh")).toContain(
      `opencode-ai@\${UNO_WORK_OPENCODE_VERSION:-${UNO_OPENCODE_VERSION}}`,
    );
    expect(read("../../desktop/src/unoCodeInstaller.ts")).toContain(
      `UNO_HARNESS_OPENCODE_VERSION = "${UNO_OPENCODE_VERSION}"`,
    );
  });
});
