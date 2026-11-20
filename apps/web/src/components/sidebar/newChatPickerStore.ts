/**
 * ⌘N and the New chat pickers on screen (T53): every picker button registers
 * how to open itself; ⌘N asks them in turn and the first one the person can
 * see opens. None on screen (sidebar hidden) — the caller starts the chat at
 * once where the picker would have.
 */
type Opener = () => boolean;

const openers = new Set<Opener>();

/** Returns the unregister function (an effect's cleanup). */
export function registerNewChatPickerOpener(opener: Opener): () => void {
  openers.add(opener);
  return () => {
    openers.delete(opener);
  };
}

/** True when a picker opened. The newest button first (the one just mounted). */
export function openNewChatPicker(): boolean {
  for (const opener of [...openers].toReversed()) {
    if (opener()) return true;
  }
  return false;
}
