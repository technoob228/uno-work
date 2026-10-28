/**
 * What of Claude Code's own status messages a person should see in the Work
 * log (cap walkthrough 28.10, P11: a plain "Hi" left four "Runtime warning"
 * rows — Claude Code 2.x reports `vcs_state_changed`, `task_updated`,
 * `background_tasks_changed`… on every turn, and each one the adapter didn't
 * know became a warning with nothing in it but its name).
 *
 * - Bookkeeping (git state, background tasks, command lists, session state,
 *   memory, plugins…) and anything not known yet: quiet. The raw message is
 *   still in the native event log.
 * - A few say something the person can use — Claude retrying a busy API,
 *   switching model after a refusal, a tool it wasn't allowed to run, its own
 *   warnings: one human line.
 *
 * Pure: no I/O.
 *
 * @module provider/Layers/claudeSystemNotices
 */

/** Subtypes known to be bookkeeping only (the rest of the unknown ones are quiet too). */
export const CLAUDE_QUIET_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  "thinking_tokens",
  "task_updated",
  "background_tasks_changed",
  "vcs_state_changed",
  "code_change_published",
  "commands_changed",
  "session_state_changed",
  "worker_shutting_down",
  "memory_recall",
  "plugin_install",
  "elicitation_complete",
  "mirror_error",
  "local_command_output",
]);

export type ClaudeSystemNotice =
  /** Nothing for the Work log. `known`: a subtype we know is bookkeeping. */
  | { readonly kind: "quiet"; readonly known: boolean }
  /** One line for the Work log. */
  | { readonly kind: "notice"; readonly summary: string };

const MAX_SUMMARY = 160;

function oneLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length === 0) return null;
  return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1)}…` : line;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

/** A Claude Code `system` message the adapter has no event for. */
export function describeClaudeSystemMessage(
  message: Readonly<Record<string, unknown>>,
): ClaudeSystemNotice {
  const subtype = typeof message.subtype === "string" ? message.subtype : "";
  switch (subtype) {
    case "api_retry": {
      const attempt = positiveInt(message.attempt);
      const max = positiveInt(message.max_retries);
      return {
        kind: "notice",
        summary:
          attempt !== null && max !== null
            ? `Claude's servers are busy — trying again (${attempt} of ${max})`
            : "Claude's servers are busy — trying again",
      };
    }
    case "model_refusal_fallback": {
      const fallback = oneLine(message.fallback_model);
      return {
        kind: "notice",
        summary: fallback
          ? `Claude answered this one with ${fallback}`
          : "Claude answered this one with another model",
      };
    }
    case "permission_denied": {
      const tool = oneLine(message.tool_name);
      const why = oneLine(message.message);
      const head = tool ? `Not allowed to run ${tool}` : "A tool wasn't allowed to run";
      return { kind: "notice", summary: oneLine(why ? `${head}: ${why}` : head) ?? head };
    }
    case "informational": {
      const content = oneLine(message.content);
      return message.level === "warning" && content
        ? { kind: "notice", summary: content }
        : { kind: "quiet", known: true };
    }
    case "notification": {
      const text = oneLine(message.text);
      return (message.priority === "high" || message.priority === "immediate") && text
        ? { kind: "notice", summary: text }
        : { kind: "quiet", known: true };
    }
    default:
      return { kind: "quiet", known: CLAUDE_QUIET_SYSTEM_SUBTYPES.has(subtype) };
  }
}
