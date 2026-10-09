/**
 * The `lastError` startup reconciliation stamps on a thread whose provider
 * session was live when the daemon went down. Shared so the Telegram/Slack
 * reply watcher can tell "cut off by a restart" (resume the turn) from a
 * provider failure (report it).
 */
export const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";
