/**
 * The agents "Update everything" keeps current, and to what. Claude Code and
 * Codex follow npm's latest. OpenCode is pinned: it is also the engine of Uno
 * Code, and a new one reaches computers only after it passed our checks.
 *
 * Keep UNO_OPENCODE_VERSION in step with `UNO_WORK_OPENCODE_VERSION` in
 * deploy/install.sh and `UNO_HARNESS_OPENCODE_VERSION` in
 * apps/desktop/src/unoCodeInstaller.ts (agentUpdates.test.ts checks it).
 */
export const UNO_OPENCODE_VERSION = "1.18.32";

export const UPDATABLE_AGENTS = [
  { driver: "claudeAgent", name: "Claude", npmPackage: "@anthropic-ai/claude-code", bin: "claude" },
  { driver: "codex", name: "Codex", npmPackage: "@openai/codex", bin: "codex" },
  { driver: "opencode", name: "OpenCode", npmPackage: "opencode-ai", bin: "opencode" },
] as const;

export type UpdatableAgentDriver = (typeof UPDATABLE_AGENTS)[number]["driver"];

/** One agent on a computer, as `GET /api/self-update/agents` tells it. */
export interface AgentUpdateStatus {
  readonly driver: UpdatableAgentDriver;
  readonly name: string;
  readonly version: string | null;
  /** The version to go to; null when the check didn't get an answer. */
  readonly target: string | null;
  /** Older than `target`, and installed in a way Uno Work can replace. */
  readonly behind: boolean;
  /** Installed by npm. Anything else updates itself or by what installed it. */
  readonly managed: boolean;
}
