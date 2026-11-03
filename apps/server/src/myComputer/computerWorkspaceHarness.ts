/**
 * How each harness is set up for a chat whose project is on the person's own
 * computer ("brain in the cloud"): its own shell and file tools off, the
 * `workspace_*` tools of uno-work (`workspaceTools.ts`) in their place, and a
 * note in its instructions saying where the project is.
 *
 * - Claude Code: `disallowedTools` removes the built-ins from the model's
 *   context; `toolAliases` sends a stray `Bash`/`Read`/… (a skill that names
 *   them) to the workspace tool instead of failing.
 * - Hermes: its `terminal`, `file` and `code_execution` toolsets off (Hermes
 *   0.21 `agent.disabled_toolsets`, subtracted last), `delegation` and
 *   `cronjob` too: they start agents with the default toolsets here.
 * - Codex (0.162.1, measured 03.11 against a fake endpoint): `shell_tool` and
 *   `unified_exec` switch its shell off, but `apply_patch` stays (no flag), so
 *   it would edit this computer's empty stand-in folder: Codex is refused for
 *   such chats (no `computerWorkspace` capability) until that can be closed.
 *
 * @module myComputer/computerWorkspaceHarness
 */
import { UNO_WORK_MCP_SERVER_NAME } from "../unoWork/constants.ts";
import type { ComputerWorkspacePlan } from "../provider/Services/ComputerWorkspacePolicy.ts";
import { workspacePromptNote } from "./workspaceTools.ts";

/** Claude Code's tools that touch this computer's shell or files. */
export const CLAUDE_LOCAL_TOOLS: ReadonlyArray<string> = [
  "Bash",
  "BashOutput",
  "KillShell",
  "KillBash",
  "Monitor",
  "PowerShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "Glob",
  "Grep",
  "LS",
];

const claudeTool = (name: string) => `mcp__${UNO_WORK_MCP_SERVER_NAME}__${name}`;

export const CLAUDE_WORKSPACE_ALIASES: Readonly<Record<string, string>> = {
  Bash: claudeTool("workspace_bash"),
  Read: claudeTool("workspace_read"),
  Write: claudeTool("workspace_write"),
  Edit: claudeTool("workspace_edit"),
  Glob: claudeTool("workspace_glob"),
  Grep: claudeTool("workspace_grep"),
  LS: claudeTool("workspace_ls"),
};

export function claudeWorkspaceOptions(plan: ComputerWorkspacePlan): {
  readonly disallowedTools: Array<string>;
  readonly toolAliases: Record<string, string>;
  readonly note: string;
} {
  return {
    disallowedTools: [...CLAUDE_LOCAL_TOOLS],
    toolAliases: { ...CLAUDE_WORKSPACE_ALIASES },
    note: workspacePromptNote(plan, `mcp__${UNO_WORK_MCP_SERVER_NAME}__`),
  };
}

/** Hermes toolsets that act on this computer. */
export const HERMES_LOCAL_TOOLSETS: ReadonlyArray<string> = [
  "terminal",
  "file",
  "code_execution",
  "delegation",
  "cronjob",
];

export function hermesWorkspaceOptions(plan: ComputerWorkspacePlan): {
  readonly disabledToolsets: ReadonlyArray<string>;
  readonly note: string;
} {
  return { disabledToolsets: HERMES_LOCAL_TOOLSETS, note: workspacePromptNote(plan, "") };
}

/** Two notes for one prompt, either may be absent. */
export function joinNotes(...notes: ReadonlyArray<string | undefined | null>): string | undefined {
  const present = notes.filter(
    (note): note is string => typeof note === "string" && note.trim().length > 0,
  );
  return present.length > 0 ? present.join("\n\n") : undefined;
}
