/**
 * The `lastError` startup reconciliation stamps on a thread whose provider
 * session was live when the daemon went down. Shared so the Telegram/Slack
 * reply watcher can tell "cut off by a restart" (resume the turn) from a
 * provider failure (report it), and so the client can say it in the
 * person's words ("Stopped by a restart").
 */
export { ORPHANED_PROVIDER_SESSION_ERROR } from "@t3tools/shared/turnErrorRetry";
