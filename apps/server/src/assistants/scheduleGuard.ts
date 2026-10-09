/**
 * Uno's schedules go through the Uno console, never Hermes' own cron.
 *
 * The brief and the instructions already say "Schedules ONLY through
 * schedule_create", yet on 09.10 (ICP v3, t2-teammate) the Uno chat answered
 * "every morning at 9 send me a plan" with `hermes cron create …` in its
 * terminal and even switched Hermes' gateway on to run it. That job lives
 * inside the computer: the console doesn't see it (Schedule → "No jobs yet"),
 * it can't wake a computer asleep in Economy, so the morning plan never came.
 *
 * The rule is made structural here: a Hermes `pre_tool_call` shell hook
 * (Hermes reads `hooks:` from the per-chat config.yaml, see
 * `buildHermesConfigYaml`) looks at every terminal / execute_code / cronjob
 * call and refuses the ones that would hide a schedule in the computer —
 * `hermes cron create|add|edit|resume|run|tick`, `hermes gateway
 * install|start|run|restart`, `crontab` (except `-l`), systemd timers. The
 * refusal tells the model the one right way: `schedule_create`, which the
 * console keeps, shows under Schedule and uses to wake the computer.
 *
 * A guard rail, not a sandbox: the hook only reads the tool call's text.
 *
 * @module assistants/scheduleGuard
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import { shellQuote } from "./schedules.ts";

/** File name of the hook script inside a chat's HERMES_HOME. */
export const SCHEDULE_GUARD_FILE = "uno-schedule-guard.sh";

/** Hermes tools whose input the guard reads (a full-match regex, Hermes' `matcher`). */
export const SCHEDULE_GUARD_TOOL_MATCHER = "terminal|execute_code|process|cronjob";

/** Seconds Hermes gives the hook; it is a grep, it takes milliseconds. */
export const SCHEDULE_GUARD_TIMEOUT_SEC = 10;

/** What the model reads instead of the tool's result. */
export const SCHEDULE_GUARD_MESSAGE =
  "Blocked by Uno Work: schedules never go into Hermes' own cron, crontab or systemd timers on this computer. " +
  "The computer sleeps when idle and only the Uno console can wake it, so such a job would silently never run, " +
  "and the person can't see or stop it. For anything recurring call the uno-manager tool schedule_create " +
  "(cron, the instruction for future-you, the person's time zone); schedule_list / schedule_delete manage them. " +
  "Then tell the person in plain words what runs when and that they see it in the Uno chat and under Schedule, " +
  "with no terminal commands. Don't retry this command another way.";

/**
 * The patterns, POSIX ERE over the hook's JSON payload (the command text is
 * inside a JSON string, so quotes arrive as `\"`). Exported for the tests.
 */
export const SCHEDULE_GUARD_PATTERNS: ReadonlyArray<string> = [
  // `hermes cron create …`, also with global flags or a path to the binary.
  "hermes[^|;&]{0,80}cron[^a-z]{1,6}(create|add|edit|resume|run|tick)([^a-z]|$)",
  // The scheduler/messaging service that runs Hermes' cron.
  "hermes[^|;&]{0,80}gateway[^a-z]{1,6}(install|start|run|restart|enable)([^a-z]|$)",
  // systemd timers.
  "systemd-run[^|;&]{0,200}--on-(calendar|active|boot|unit-active)",
  "OnCalendar=",
  "systemctl[^|;&]{0,80}(enable|start)[^|;&]{0,80}[.]timer",
];

/** Hermes' own cron tool: anything but reading or removing. */
const CRONJOB_TOOL_PATTERN = '"tool_name": *"cronjob"';
const CRONJOB_READ_PATTERN = '"action": *"(list|remove|delete|status|pause)"';

/** `crontab` writes: any use but `crontab -l` (also `(crontab -l; …) | crontab -`). */
const CRONTAB_WRITE_PATTERN = "(^|[^a-z_-])crontab( +-[^l]| +[^ -]|[^a-z_ -]|$)";

function blockJson(): string {
  return JSON.stringify({ decision: "block", reason: SCHEDULE_GUARD_MESSAGE });
}

/** The hook script: reads Hermes' JSON payload on stdin, prints a block or nothing. */
export function scheduleGuardScript(): string {
  const any = SCHEDULE_GUARD_PATTERNS.map((pattern) => `-e ${shellQuote(pattern)}`).join(" ");
  return [
    "#!/bin/sh",
    "# Uno Work (assistants/scheduleGuard.ts): schedules go through the Uno console,",
    "# never Hermes' own cron. Hermes runs this before terminal/execute_code/cronjob calls.",
    'payload=$(cat)',
    "block() {",
    `  printf '%s\\n' ${shellQuote(blockJson())}`,
    "  exit 0",
    "}",
    `if printf '%s' "$payload" | grep -Eq ${shellQuote(CRONJOB_TOOL_PATTERN)}; then`,
    `  printf '%s' "$payload" | grep -Eq ${shellQuote(CRONJOB_READ_PATTERN)} || block`,
    "  exit 0",
    "fi",
    `printf '%s' "$payload" | grep -Eq ${any} && block`,
    `printf '%s' "$payload" | grep -Eq ${shellQuote(CRONTAB_WRITE_PATTERN)} && block`,
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Write the hook script into a chat's HERMES_HOME (idempotent) and return the
 * hook's command line for config.yaml (Hermes splits it with shlex, no shell).
 */
export async function writeScheduleGuard(hermesHome: string): Promise<string> {
  const path = nodePath.join(hermesHome, SCHEDULE_GUARD_FILE);
  const script = scheduleGuardScript();
  const current = await fs.readFile(path, "utf8").catch(() => null);
  if (current !== script) {
    await fs.mkdir(hermesHome, { recursive: true });
    await fs.writeFile(path, script, { mode: 0o755 });
  }
  return `/bin/sh ${shellQuote(path)}`;
}
