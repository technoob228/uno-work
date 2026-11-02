/**
 * The daemon was told to stop. systemd signals the whole service at once, so
 * the agents exit around the same moment as this process, and their exits used
 * to land in the chat as a failed turn ("OpenCode server exited unexpectedly
 * (0)") right before the daemon went down. From this flag on, what agents do
 * is not news: the next daemon reconciles those turns and continues them.
 */
let stopping = false;

export const isDaemonStopping = (): boolean => stopping;

let watching = false;

/** Added next to the runtime's own handlers, which do the actual stopping. */
export function watchDaemonStop(): void {
  if (watching) return;
  watching = true;
  const onStop = () => {
    stopping = true;
  };
  process.once("SIGTERM", onStop);
  process.once("SIGINT", onStop);
}
