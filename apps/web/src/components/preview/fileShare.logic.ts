/**
 * What ↗ on a file in the panel does (w0138, point 8, Misha 16.10):
 *
 * - Desktop app: a small menu — "Open in <editor>" (as before) and
 *   "Share with a link…".
 * - Work on a cloud computer: ↗ is the Share button itself.
 *
 * And how the link is made: a file on a computer with a public address (a
 * cloud computer) gets a link from that computer — it wakes up for the
 * visitor. A file on the laptop can't be reached from the internet, so Share
 * first uploads a copy to Cloud storage and shares that.
 */

export type FileShareRoute = "computer-link" | "cloud-copy";

export interface FileActionPlan {
  /** ↗ opens a menu with "Open in <editor>" (desktop) or is the Share button (cloud). */
  readonly menu: boolean;
  readonly share: FileShareRoute;
}

export function planFileActions(input: {
  readonly desktop: boolean;
  /** The file lives on the computer this app runs on (the laptop). */
  readonly onThisLaptop: boolean;
}): FileActionPlan {
  return {
    menu: input.desktop,
    share: input.desktop && input.onThisLaptop ? "cloud-copy" : "computer-link",
  };
}

/** Folder in Cloud storage for copies made to share from the laptop. */
export const SHARED_COPIES_PREFIX = "Shared/";

export function sharedCopyKey(name: string): string {
  return `${SHARED_COPIES_PREFIX}${name}`;
}

/**
 * The key of the copy `cloudCopyToCloud` makes of one file: the prefix plus
 * the file's name on disk (the daemon's `copyToCloud` uses the basename).
 */
export function sharedCopyKeyForPath(path: string): string {
  const name =
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? path;
  return sharedCopyKey(name);
}
