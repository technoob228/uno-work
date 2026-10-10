import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { buildHermesConfigYaml } from "../provider/acp/HermesAcpSupport.ts";
import {
  SCHEDULE_GUARD_FILE,
  SCHEDULE_GUARD_MESSAGE,
  SCHEDULE_GUARD_TIMEOUT_SEC,
  SCHEDULE_GUARD_TOOL_MATCHER,
  writeScheduleGuard,
} from "./scheduleGuard.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function guardHome(): Promise<string> {
  // A space in the path: on a Mac the state dir is under "Application Support".
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "uno schedule-guard-"));
  dirs.push(dir);
  return dir;
}

/** Run the hook the way Hermes does: JSON on stdin, JSON (or nothing) on stdout. */
function runGuard(script: string, toolName: string, toolInput: Record<string, unknown>): string {
  const payload = JSON.stringify({
    hook_event_name: "pre_tool_call",
    tool_name: toolName,
    tool_input: toolInput,
    session_id: "s1",
    cwd: "/home/uno/assistant",
    extra: {},
  });
  return execFileSync("/bin/sh", [script], { input: payload, encoding: "utf8" }).trim();
}

const blocked = (out: string) => out !== "" && JSON.parse(out).decision === "block";

describe("schedule guard", () => {
  it("refuses Hermes' own cron, its gateway, crontab writes and systemd timers", async () => {
    const home = await guardHome();
    await writeScheduleGuard(home);
    const script = nodePath.join(home, SCHEDULE_GUARD_FILE);
    const refused = [
      'hermes cron create --name daily-morning-plan "0 12 * * *" "Send me the plan"',
      '~/.local/bin/hermes --profile x cron add "every day at 9am" "plan"',
      "hermes cron resume daily-morning-plan",
      "hermes gateway install && hermes gateway start",
      '(crontab -l; echo "0 9 * * * ~/plan.sh") | crontab -',
      "crontab -e",
      'systemd-run --user --on-calendar="*-*-* 09:00" ~/plan.sh',
      "systemctl --user enable --now plan.timer",
    ];
    for (const command of refused) {
      expect(blocked(runGuard(script, "terminal", { command })), command).toBe(true);
    }
    const out = runGuard(script, "terminal", { command: refused[0]! });
    expect(JSON.parse(out).reason).toBe(SCHEDULE_GUARD_MESSAGE);
    expect(
      blocked(
        runGuard(script, "execute_code", {
          code: 'import subprocess\nsubprocess.run(["hermes", "cron", "create", "0 9 * * *", "plan"])',
        }),
      ),
    ).toBe(true);
    expect(blocked(runGuard(script, "cronjob", { action: "create", schedule: "0 9 * * *" }))).toBe(
      true,
    );
  });

  it("lets everything else through, including reading and removing old jobs", async () => {
    const home = await guardHome();
    await writeScheduleGuard(home);
    const script = nodePath.join(home, SCHEDULE_GUARD_FILE);
    const allowed = [
      "hermes cron list",
      "hermes cron remove daily-morning-plan",
      "crontab -l",
      "ls ~/.hermes/cron/",
      "git clone https://github.com/sindresorhus/slugify && cd slugify && npm test",
      "echo crontab-like",
    ];
    for (const command of allowed) {
      expect(runGuard(script, "terminal", { command }), command).toBe("");
    }
    expect(runGuard(script, "cronjob", { action: "list" })).toBe("");
  });

  it("goes into config.yaml as an auto-accepted pre_tool_call hook", async () => {
    const home = await guardHome();
    const command = await writeScheduleGuard(home);
    expect(command).toBe(`/bin/sh '${nodePath.join(home, SCHEDULE_GUARD_FILE)}'`);
    // Idempotent: a second write keeps the same file and command.
    expect(await writeScheduleGuard(home)).toBe(command);
    const yaml = buildHermesConfigYaml({
      model: "uno/smart",
      mcpServers: [],
      preToolCallHook: {
        command,
        matcher: SCHEDULE_GUARD_TOOL_MATCHER,
        timeoutSec: SCHEDULE_GUARD_TIMEOUT_SEC,
      },
    });
    expect(yaml).toContain(
      [
        "hooks_auto_accept: true",
        "hooks:",
        "  pre_tool_call:",
        `    - matcher: "terminal|execute_code|process|cronjob"`,
        `      command: ${JSON.stringify(command)}`,
        "      timeout: 10",
      ].join("\n"),
    );
    expect(buildHermesConfigYaml({ model: "uno/smart", mcpServers: [] })).not.toContain("hooks");
  });
});
