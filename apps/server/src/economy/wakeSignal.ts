/**
 * "This computer just woke up" for long-polls.
 *
 * An economy computer can be frozen in the middle of a long-poll (Telegram
 * getUpdates through the Uno relay, Slack relay events). After the freeze the
 * socket looks alive but nobody is on the other end any more, and fetch would
 * wait for its own timeout — minutes by default — while the message that woke
 * the computer sits in the relay queue. EconomyPresence detects the wake (a
 * clock gap between its ticks) and fires this signal; pollers pass
 * {@link longPollSignal} so the stale request is dropped at once and the next
 * poll picks the message up.
 */
let controller = new AbortController();

/** Aborts the in-flight long-polls; later polls get a fresh signal. */
export function signalMachineWoke(): void {
  const previous = controller;
  controller = new AbortController();
  previous.abort(new Error("the computer woke up; retrying the long-poll"));
}

/** Signal for one long-poll: its own timeout, or a wake, whichever comes first. */
export function longPollSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), controller.signal]);
}
