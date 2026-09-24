/**
 * Starter suggestions under Home's composer, made from what this person
 * already has — not a fixed list. Deterministic and instant: rules over the
 * data Home fetches anyway (recent chats, their apps, files changed lately in
 * the home folder, their sites). Only with none of that do the generic
 * starters show.
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

export interface StarterApp {
  readonly name: string;
  /**
   * `registered` = built on this computer (by the AI or the person),
   * `store` = from the App Store, `container` = a docker container the person
   * started. The computer's own programs never get here.
   */
  readonly kind: "registered" | "store" | "container";
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

export interface StarterContext {
  readonly chats: ReadonlyArray<StarterChat>;
  readonly apps: ReadonlyArray<StarterApp>;
  readonly files: ReadonlyArray<StarterFile>;
  readonly sites: ReadonlyArray<StarterSite>;
}

export type StarterSource = "chat" | "app" | "file" | "site" | "generic";

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
  {
    id: "generic:downloads",
    label: "Clean up my Downloads folder",
    prompt:
      "Clean up my Downloads folder: sort the files into subfolders by type and tell me what you moved.",
    source: "generic",
  },
  {
    id: "generic:explain",
    label: "Explain what's running on this computer",
    prompt: "Explain what's running on this computer, in plain words.",
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

function chatStarters(chats: ReadonlyArray<StarterChat>): HomeStarter[] {
  const seen = new Set<string>();
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

function appStarters(apps: ReadonlyArray<StarterApp>): HomeStarter[] {
  const seen = new Set<string>();
  const out: HomeStarter[] = [];
  // Apps built here first: those are the ones the person can change.
  const order = { registered: 0, store: 1, container: 2 } as const;
  for (const app of apps.toSorted((a, b) => order[a.kind] - order[b.kind])) {
    const name = app.name.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const short = shortName(name, 24);
    switch (app.kind) {
      case "registered":
        out.push({
          id: `app:${name}`,
          label: `Add a login page to ${short}`,
          prompt: `Add a login page to my app ${name}, so only people I allow can open it.`,
          source: "app",
        });
        break;
      case "store":
        out.push({
          id: `app:${name}`,
          label: `Set up a backup for ${short}`,
          prompt: `Set up a daily backup of ${name}'s data on this computer, and tell me how to restore it.`,
          source: "app",
        });
        break;
      case "container":
        out.push({
          id: `app:${name}`,
          label: `Explain what ${short} does`,
          prompt: `Explain what ${name} on this computer does, whether it is healthy, and what I could use it for.`,
          source: "app",
        });
        break;
    }
  }
  return out;
}

/** Files first (they make concrete tasks), then at most one folder to tidy. */
function fileStarters(files: ReadonlyArray<StarterFile>): HomeStarter[] {
  const fileTasks: HomeStarter[] = [];
  let folderTask: HomeStarter | null = null;
  const recent = files
    .filter((file) => !file.name.startsWith("."))
    .toSorted((a, b) => (Date.parse(b.modifiedAt) || 0) - (Date.parse(a.modifiedAt) || 0));
  for (const file of recent) {
    const short = shortName(file.name, 28);
    if (file.isDirectory) {
      folderTask ??= {
        id: `file:${file.name}`,
        label: `Tidy up ${short}`,
        prompt: `Tidy up the folder ${file.name} in my home folder: sort what's inside and tell me what you changed.`,
        source: "file",
      };
      continue;
    }
    const ext = extensionOf(file.name);
    if (SHEET_EXT.has(ext)) {
      fileTasks.push({
        id: `file:${file.name}`,
        label: `Make a chart from ${short}`,
        prompt: `Make a chart from ${file.name} in my home folder and tell me what stands out.`,
        source: "file",
      });
    } else if (DOC_EXT.has(ext) || DECK_EXT.has(ext)) {
      fileTasks.push({
        id: `file:${file.name}`,
        label: `Summarize ${short}`,
        prompt: `Summarize ${file.name} from my home folder in a few bullet points.`,
        source: "file",
      });
    }
    // Other files (images, archives, code) make no obvious one-click task.
  }
  return folderTask ? [...fileTasks, folderTask] : fileTasks;
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

/**
 * Up to `max` starters: one from each kind of context in turn (a chat, an
 * app, a file, a site), then the next of each, so no single source fills the
 * row. Generic starters only when there is no context at all.
 */
export function homeStarters(
  context: StarterContext,
  max: number = MAX_HOME_STARTERS,
): HomeStarter[] {
  const pools = [
    chatStarters(context.chats),
    appStarters(context.apps),
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
  return out.length > 0 ? out : GENERIC_STARTERS.slice(0, max);
}
