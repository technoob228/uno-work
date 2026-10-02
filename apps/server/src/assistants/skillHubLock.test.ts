import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeOwnComputerRoleReader, parseComputerRole } from "./computerRole.ts";
import { lockHermesSkillHub, SKILL_HUB_LOCK_TEXT } from "./skillHubLock.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempHome = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
  dirs.push(dir);
  return dir;
};

describe("Hermes skills hub lock", () => {
  it("puts a file where Hermes keeps its hub directory, idempotently", async () => {
    const home = tempHome();
    expect(await lockHermesSkillHub(home)).toBe("locked");
    const hub = path.join(home, "skills", ".hub");
    expect(statSync(hub).isFile()).toBe(true);
    expect(readFileSync(hub, "utf8")).toBe(SKILL_HUB_LOCK_TEXT);
    expect(await lockHermesSkillHub(home)).toBe("already-locked");
  });

  it("replaces a hub directory left by an earlier install", async () => {
    const home = tempHome();
    mkdirSync(path.join(home, "skills", ".hub", "quarantine"), { recursive: true });
    writeFileSync(path.join(home, "skills", ".hub", "lock.json"), "{}");
    writeFileSync(path.join(home, "skills", "my-skill.md"), "keep me");
    expect(await lockHermesSkillHub(home)).toBe("replaced-directory");
    expect(statSync(path.join(home, "skills", ".hub")).isFile()).toBe(true);
    expect(readFileSync(path.join(home, "skills", "my-skill.md"), "utf8")).toBe("keep me");
  });
});

describe("this computer's role", () => {
  it("parses computer_role", () => {
    expect(parseComputerRole({ computer_role: "assistant" })).toBe("assistant");
    expect(parseComputerRole({ computer_role: "" })).toBeNull();
    expect(parseComputerRole(null)).toBeNull();
  });

  it("asks the console once with the machine token and caches; a laptop is null", async () => {
    let calls = 0;
    const read = makeOwnComputerRoleReader({
      fetchImpl: async (url, init) => {
        calls += 1;
        expect(String(url).endsWith("/api/v1/boxes/7")).toBe(true);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer uno_agt_x");
        return new Response(JSON.stringify({ id: 7, computer_role: "assistant" }));
      },
    });
    const uno = { boxToken: "uno_agt_x", boxId: 7 };
    expect(await read(uno)).toBe("assistant");
    expect(await read(uno)).toBe("assistant");
    expect(calls).toBe(1);
    expect(await read({ boxToken: "", boxId: null })).toBeNull();
    const failing = makeOwnComputerRoleReader({
      fetchImpl: async () => new Response("no", { status: 500 }),
    });
    expect(await failing(uno)).toBeNull();
  });
});
