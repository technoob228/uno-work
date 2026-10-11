/**
 * Starter suggestions under Home's composer, made from the work this person
 * already did here — not a fixed list. Deterministic and instant: rules over
 * the data Home fetches anyway (recent chats, app notifications, documents
 * changed lately in the home folder, their sites).
 *
 * Misha 11.10: "the hints are dumb — make them from the work in chats, and
 * with few projects give what helps to get on board: learn Uno Work, Uno
 * cloud services". So nothing is guessed from what merely sits on the
 * computer (an app → "add a login page", a folder → "tidy up" are gone), and
 * a person with fewer than two projects gets the onboarding starters first.
 *
 * A click pre-fills the composer (never sends); a starter that belongs to a
 * folder (a chat's project) also switches the composer's folder chip there.
 */

export interface StarterChat {
  readonly title: string;
  /** Epoch ms of the chat's last activity. */
  readonly activityAt: number;
  /** The chat's folder; null = unknown / the home folder. */
  readonly folder: { readonly cwd: string; readonly name: string } | null;
}

export interface StarterFile {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly modifiedAt: string;
}

export interface StarterSite {
  /** The custom domain when there is one, else the slug. */
  readonly name: string;
}

/** An unread app notification from the Inbox. */
export interface StarterNotification {
  readonly id: string;
  /** The app's name. */
  readonly source: string;
  readonly title: string;
  readonly body: string | null;
}

export interface StarterContext {
  readonly chats: ReadonlyArray<StarterChat>;
  /**
   * Projects the person added (the home folder and assistants' folders don't
   * count). Fewer than `ONBOARDING_BELOW_PROJECTS` = still getting on board.
   */
  readonly projectCount: number;
  readonly files: ReadonlyArray<StarterFile>;
  readonly sites: ReadonlyArray<StarterSite>;
  readonly notifications?: ReadonlyArray<StarterNotification>;
  /**
   * Titles of the chats Home already shows under "Continue": a starter for
   * them would repeat the card right below, so they are skipped.
   */
  readonly continueTitles?: ReadonlyArray<string>;
}

export type StarterSource = "chat" | "notification" | "file" | "site" | "onboarding" | "generic";

export interface HomeStarter {
  readonly id: string;
  /** The chip. */
  readonly label: string;
  /** What lands in the composer — visible and editable before sending. */
  readonly prompt: string;
  readonly source: StarterSource;
  /** Work in this folder instead of the home folder. */
  readonly folder?: { readonly cwd: string; readonly name: string };
}

export const MAX_HOME_STARTERS = 4;

/** With fewer projects than this, the person is still finding their way around. */
export const ONBOARDING_BELOW_PROJECTS = 2;

/** What helps to get on board: what this place is, and what comes with it. */
export const ONBOARDING_STARTERS: ReadonlyArray<HomeStarter> = [
  {
    id: "onboarding:learn",
    label: "Learn Uno Work",
    prompt:
      "Show me around Uno Work: what I can do here and how, in a few short steps. Then suggest one thing to try first on this computer.",
    source: "onboarding",
  },
  {
    id: "onboarding:cloud",
    label: "Uno cloud services",
    prompt:
      "What comes with my Uno account besides this computer — sites, Cloud storage, databases, apps on the internet, AI? Explain each in a line and show me how to use one from here.",
    source: "onboarding",
  },
];

/** Things to start from scratch; they fill the row while there is little work to go on. */
export const GENERIC_STARTERS: ReadonlyArray<HomeStarter> = [
  {
    id: "generic:app",
    label: "Make me an app that…",
    prompt: "Make me an app that ",
    source: "generic",
  },
  {
    id: "generic:site",
    label: "Publish a site from a folder",
    prompt: "Publish a site from a folder on this computer. Ask me which folder first.",
    source: "generic",
  },
];

const MAX_NAME = 32;

/** A name short enough for a chip: cut at a word when possible. */
export function shortName(value: string, max = MAX_NAME): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const PLACEHOLDER_TITLE = /^(new (thread|chat)|untitled)$/i;

function isMeaningfulTitle(title: string): boolean {
  const clean = title.trim();
  return clean.length >= 3 && !PLACEHOLDER_TITLE.test(clean);
}

const DOC_EXT = new Set(["pdf", "doc", "docx", "md", "txt", "rtf", "odt", "pages"]);
const SHEET_EXT = new Set(["csv", "xls", "xlsx", "ods", "numbers", "tsv"]);
const DECK_EXT = new Set(["ppt", "pptx", "odp", "key"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function chatStarters(
  chats: ReadonlyArray<StarterChat>,
  continueTitles: ReadonlyArray<string>,
): HomeStarter[] {
  const seen = new Set<string>(continueTitles.map((title) => title.trim().toLowerCase()));
  const out: HomeStarter[] = [];
  for (const chat of chats.toSorted((a, b) => b.activityAt - a.activityAt)) {
    const title = chat.title.trim();
    const key = title.toLowerCase();
    if (!isMeaningfulTitle(title) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `chat:${key}`,
      label: `Next step for “${shortName(title)}”`,
      prompt: `Last time we worked on “${title}”. Look at where it stands in this folder and suggest the next step.`,
      source: "chat",
      ...(chat.folder ? { folder: chat.folder } : {}),
    });
  }
  return out;
}

const REPLY_WORDS = /\b(comment(ed)?|replied|reply|message|asked|mentioned|question)\b/i;

function notificationStarters(items: ReadonlyArray<StarterNotification>): HomeStarter[] {
  return items
    .filter((item) => item.title.trim())
    .map((item) => {
      const title = item.title.trim();
      const body = item.body?.trim() ? ` ${item.body.trim()}` : "";
      return REPLY_WORDS.test(`${title} ${item.body ?? ""}`)
        ? {
            id: `notification:${item.id}`,
            label: `Reply to “${shortName(title, 28)}”`,
            prompt: `${item.source} says: “${title}”${body} Help me reply to it.`,
            source: "notification" as const,
          }
        : {
            id: `notification:${item.id}`,
            label: `Look at ${shortName(item.source, 20)} alert`,
            prompt: `${item.source} on this computer says: “${title}”${body} Look into it and tell me what to do.`,
            source: "notification" as const,
          };
    });
}

/** Documents and sheets changed lately: the only files with an obvious one-click task. */
function fileStarters(files: ReadonlyArray<StarterFile>): HomeStarter[] {
  const out: HomeStarter[] = [];
  const recent = files
    .filter((file) => !file.isDirectory && !file.name.startsWith("."))
    .toSorted((a, b) => (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0));
  for (const file of recent) {
    const short = shortName(file.name, 28);
    const ext = extensionOf(file.name);
    if (SHEET_EXT.has(ext)) {
      out.push({
        id: `file:${file.name}`,
        label: `Make a chart from ${short}`,
        prompt: `Make a chart from ${file.name} in my home folder and tell me what stands out.`,
        source: "file",
      });
    } else if (DOC_EXT.has(ext) || DECK_EXT.has(ext)) {
      out.push({
        id: `file:${file.name}`,
        label: `Summarize ${short}`,
        prompt: `Summarize ${file.name} from my home folder in a few bullet points.`,
        source: "file",
      });
    }
    // Other files (images, archives, code) and folders make no obvious task.
  }
  return out;
}

function siteStarters(sites: ReadonlyArray<StarterSite>): HomeStarter[] {
  return sites
    .filter((site) => site.name.trim())
    .map((site) => ({
      id: `site:${site.name}`,
      label: `Publish an update to ${shortName(site.name, 28)}`,
      prompt: `I want to update my site ${site.name}. Ask me what to change, make the change, and publish it again.`,
      source: "site" as const,
    }));
}

/** One from each kind of work in turn (a chat, a notification, a file, a site), then the next of each. */
function workStarters(context: StarterContext, max: number): HomeStarter[] {
  const pools = [
    chatStarters(context.chats, context.continueTitles ?? []),
    notificationStarters(context.notifications ?? []),
    fileStarters(context.files),
    siteStarters(context.sites),
  ];
  const out: HomeStarter[] = [];
  for (let round = 0; out.length < max; round += 1) {
    let added = false;
    for (const pool of pools) {
      const next = pool[round];
      if (!next) continue;
      added = true;
      out.push(next);
      if (out.length >= max) break;
    }
    if (!added) break;
  }
  return out;
}

/**
 * Up to `max` starters.
 *
 * - Still getting on board (fewer than two projects): the onboarding starters
 *   first, then what the person's own work suggests, then things to start
 *   from scratch.
 * - Otherwise: what their work suggests, no single source filling the row;
 *   the onboarding starters only when the work suggests nothing.
 */
export function homeStarters(
  context: StarterContext,
  max: number = MAX_HOME_STARTERS,
): HomeStarter[] {
  if (context.projectCount < ONBOARDING_BELOW_PROJECTS) {
    const work = workStarters(context, max - ONBOARDING_STARTERS.length);
    return [...ONBOARDING_STARTERS, ...work, ...GENERIC_STARTERS].slice(0, max);
  }
  const work = workStarters(context, max);
  return work.length > 0 ? work : [...ONBOARDING_STARTERS, ...GENERIC_STARTERS].slice(0, max);
}
