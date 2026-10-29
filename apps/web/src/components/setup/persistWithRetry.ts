/**
 * A settings write right after load can get lost: a fresh clone rotates its
 * session key in the first seconds and a write sent then may never land (prod
 * 26.09: the goal from the console was lost; walk 29.10: the "sign-in already
 * shown" mark, so the Claude Code sign-in opened again on the account's own
 * address). The write must be idempotent and always sent (the setup hook
 * skips a write that looks done locally — and a lost one does): send once
 * (waiting at most 6 s) and repeat a few times in the background.
 *
 * @module components/setup/persistWithRetry
 */
export async function persistWithRetry(
  write: () => Promise<void>,
  label = "[settings]",
): Promise<void> {
  const once = () =>
    Promise.race([write(), new Promise<void>((resolve) => setTimeout(resolve, 6000))]).catch(
      (error: unknown) => console.warn(`${label} settings write failed`, error),
    );
  await once();
  for (const delay of [3000, 8000, 15000]) {
    setTimeout(() => void once(), delay);
  }
}
