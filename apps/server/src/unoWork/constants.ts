/** Names and paths of the `uno-work` MCP server (no imports: safe from any layer). */
export const UNO_WORK_MCP_SERVER_NAME = "uno-work";
export const UNO_WORK_MCP_PATH = "/api/uno-work/mcp";
export const UNO_WORK_GUIDE_PATH = "/api/uno-work/guide";
export const UNO_WORK_APPROVAL_RESULT_PATH = "/api/uno-work/approval/result";
/**
 * Tool-call argument through which a shared uno-code/OpenCode server names the
 * calling OpenCode session (the session-env plugin adds it, the daemon strips
 * it). The session id is not a secret: the daemon maps it to the thread via
 * the 0600 session-env file it wrote itself.
 */
export const UNO_WORK_MCP_SESSION_ARG = "__uno_work_session";
