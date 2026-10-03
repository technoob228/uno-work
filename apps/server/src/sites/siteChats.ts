/**
 * Which chat made a site: `site_publish` notes the calling chat next to the
 * site's slug, and the Sites screen shows "Made in chat …" — one click back
 * to where the site was made (sidebar D, 0.0.106).
 *
 * Kept on this computer in `~/.uno/site-chats.json` (the console doesn't know
 * chats). A site published elsewhere (the console, another computer) simply
 * has no chat. Never throws: the record is a convenience, not a source of
 * truth.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SiteChat {
  readonly threadId: string;
  readonly title: string;
  /** ISO time of the latest publish from that chat. */
  readonly at: string;
}

export type SiteChats = Readonly<Record<string, SiteChat>>;

const FILE_NAME = "site-chats.json";
const MAX_SITES = 500;
const TITLE_MAX = 120;

export function siteChatsFile(home: string): string {
  return path.join(home, ".uno", FILE_NAME);
}

function parse(text: string): Record<string, SiteChat> {
  const out: Record<string, SiteChat> = {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const threadId = entry["threadId"];
    const title = entry["title"];
    const at = entry["at"];
    if (typeof threadId !== "string" || threadId.length === 0) continue;
    out[slug] = {
      threadId,
      title: typeof title === "string" ? title : "",
      at: typeof at === "string" ? at : "",
    };
  }
  return out;
}

export async function readSiteChats(home: string): Promise<SiteChats> {
  try {
    return parse(await readFile(siteChatsFile(home), "utf8"));
  } catch {
    return {};
  }
}

async function write(home: string, chats: Record<string, SiteChat>): Promise<void> {
  const file = siteChatsFile(home);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(chats, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/** The newest MAX_SITES entries stay; the oldest fall off. */
export function trimSiteChats(chats: Record<string, SiteChat>): Record<string, SiteChat> {
  const entries = Object.entries(chats);
  if (entries.length <= MAX_SITES) return chats;
  return Object.fromEntries(
    entries.toSorted(([, a], [, b]) => b.at.localeCompare(a.at)).slice(0, MAX_SITES),
  );
}

export async function recordSiteChat(
  home: string,
  slug: string,
  chat: { readonly threadId: string; readonly title: string },
  now: () => Date = () => new Date(),
): Promise<void> {
  try {
    const chats = { ...(await readSiteChats(home)) };
    chats[slug] = {
      threadId: chat.threadId,
      title: chat.title.trim().slice(0, TITLE_MAX),
      at: now().toISOString(),
    };
    await write(home, trimSiteChats(chats));
  } catch {
    // a convenience record: publishing already worked
  }
}

export async function forgetSiteChat(home: string, slug: string): Promise<void> {
  try {
    const chats = { ...(await readSiteChats(home)) };
    if (!(slug in chats)) return;
    delete chats[slug];
    await write(home, chats);
  } catch {
    // nothing to forget
  }
}
