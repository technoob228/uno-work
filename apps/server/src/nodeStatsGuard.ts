/**
 * Guard for a Node 22 footgun that blanked the Files app.
 *
 * `fs.Stats.prototype.mtime` (and atime/ctime/birthtime) is a lazy getter that
 * caches the Date on `this`. Anything that reads it on the prototype itself —
 * Effect's `Cause.pretty` walks error objects this deep when a trace span ends
 * with a failure (an aborted static download is enough) — computes a Date from
 * `undefined` and caches "Invalid Date" ON THE PROTOTYPE. From then on every
 * Stats object in the process reports an invalid mtime until the daemon
 * restarts: Files listed empty folders and "Couldn't read this item (Invalid
 * time value)".
 *
 * The guard makes the getters return undefined when read on the prototype, so
 * nothing gets cached there. Instances behave exactly as before.
 */
import fs from "node:fs";

const DATE_KEYS = ["atime", "mtime", "ctime", "birthtime"] as const;

export function guardNodeStatsPrototype(proto: object = fs.Stats.prototype): void {
  for (const key of DATE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    const get = descriptor?.get;
    if (!descriptor || !get || (get as { unoGuarded?: boolean }).unoGuarded) continue;
    const guarded = function (this: unknown) {
      if (this === proto) return undefined;
      return get.call(this);
    };
    (guarded as { unoGuarded?: boolean }).unoGuarded = true;
    Object.defineProperty(proto, key, { ...descriptor, get: guarded });
  }
}
