/**
 * The environment brief every AI in Uno Work gets, in every chat, whatever
 * the harness: Claude (appended system prompt), Codex (developer
 * instructions), OpenCode and the built-in Uno AI (an instructions file),
 * Cursor (first prompt block), Hermes (environment hint) and custom ACP
 * harnesses (their first prompt).
 *
 * One source of truth: `unoWorkBrief.md` (embedded by
 * `apps/server/scripts/embed-agent-context.ts`). It stays short and points
 * to the `uno-work` MCP tools and `uno_guide(topic)` for the long contracts.
 */
import * as FS from "node:fs";
import * as Path from "node:path";

import { UNO_WORK_BRIEF_MARKDOWN } from "./unoWorkBrief.generated.ts";

export const UNO_WORK_BRIEF_FILE_NAME = "uno-work-brief.md";

export function buildUnoWorkBrief(): string {
  return UNO_WORK_BRIEF_MARKDOWN.trim();
}

/**
 * How to run and close a task — for the harnesses on the Uno gateway (Hermes,
 * Uno Code) and OpenCode. The harness benchmark of 27.09.2026
 * (reports/harness_bench_2026-09) found Hermes ending finished work with a raw
 * verification log instead of an answer, and OpenCode stopping at "Shall I?"
 * right after "do it". Kept out of the brief itself (its ~1.5k-token budget).
 */
export const UNO_WORK_TASK_RULES = `## Doing the task

- When the person tells you to do something, do it to the end. Don't stop to ask "Shall I?" or hand back a plan instead. Ask only when the choice is really theirs or a step can't be undone; sensitive tools ask for Allow on their own.
- Finish every task (not a quick answer) with a short summary for the person, in their language and plain words, never a raw log, diff or test output:
  - **Done:** what you did and the result.
  - **Checked:** how you know it works.
  - **Your call:** what they need to decide or do, or "nothing".
- Check your result once, the simplest way that shows it works (one command, or one tool call: after \`app_register\`, \`apps_list\` shows the app). One check is enough: don't repeat it "to be sure", don't write a test script for a small job.
- Before a step that takes a while, say what you are doing in one short line ("Checking the bot starts…"). Never end a turn on a promise ("Let me verify…"): do it, then answer.
- How you check is your business: never mention temporary files, checking scripts, system messages or what the workspace "wants" to the person. Never show them raw output ("SELFTEST OK", exit codes), paths outside \`~\` or lists of changed files unless they ask.
- A message that starts with "(Uno Work)" comes from the computer, not the person: act on it, never quote or answer it as if they wrote it.
- Ask first for what only the person can give (a bot token, a login, a choice that is theirs): in your first answer, in one line, then do the rest while they get it. Don't discover after ten minutes of work that you needed it.
- If the person will give a key or token later, call \`request_secret\` with \`wait: false\`, finish everything else and end the turn; their answer comes back to this chat.
- Before building something big, check Uno doesn't already have it: their assistant (\`assistant_connect\`), sites, apps on Home, connected tools. One minute with what exists beats twenty minutes of new code.`;

/** The brief plus {@link UNO_WORK_TASK_RULES}. */
export function buildUnoWorkBriefWithTaskRules(): string {
  return `${buildUnoWorkBrief()}\n\n${UNO_WORK_TASK_RULES}`;
}

/**
 * Writes the brief and the task rules to `<stateDir>/uno-work-brief.md` for
 * harnesses whose instructions are a file path (OpenCode, Uno). Idempotent; undefined when
 * the file can't be written.
 */
export function writeUnoWorkBriefFile(stateDir: string): string | undefined {
  const filePath = Path.join(stateDir, UNO_WORK_BRIEF_FILE_NAME);
  try {
    FS.mkdirSync(stateDir, { recursive: true });
    FS.writeFileSync(filePath, `${buildUnoWorkBriefWithTaskRules()}\n`, "utf8");
    return filePath;
  } catch {
    return undefined;
  }
}
