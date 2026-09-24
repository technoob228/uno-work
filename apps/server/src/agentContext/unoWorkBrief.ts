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
 * Writes the brief to `<stateDir>/uno-work-brief.md` for harnesses whose
 * instructions are a file path (OpenCode, Uno). Idempotent; undefined when
 * the file can't be written.
 */
export function writeUnoWorkBriefFile(stateDir: string): string | undefined {
  const filePath = Path.join(stateDir, UNO_WORK_BRIEF_FILE_NAME);
  try {
    FS.mkdirSync(stateDir, { recursive: true });
    FS.writeFileSync(filePath, `${buildUnoWorkBrief()}\n`, "utf8");
    return filePath;
  } catch {
    return undefined;
  }
}
