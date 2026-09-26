/**
 * Apps by what they do, not by their brand. "Nextcloud" means nothing to most
 * people; "Files & documents" does. The App Store and every list of installed
 * apps show the task name large and the product name small and muted.
 *
 * Keyed by App Store catalog id (the console's `templates.yaml`). A few ids
 * are here before they reach the catalog, so a new app gets a plain name the
 * day it ships. Apps made by Uno whose name already says what they do
 * ("Uno Drive", "Uno Tasks") are not listed: they keep their name.
 */

export interface AppTask {
  /** 1–3 plain words: what the app is for. */
  readonly task: string;
  /** One short line: what you get. */
  readonly line: string;
  /** The product name to show small, when the catalog's name isn't it ("Chat (Matrix)" → "Matrix"). */
  readonly product?: string;
}

export const APP_TASKS: Readonly<Record<string, AppTask>> = {
  // In the catalog (fishcode back/internal/apps/templates.yaml, 25.09).
  nextcloud: { task: "Files & documents", line: "Your files on every device, like Google Drive" },
  notetaker: { task: "Meeting notes", line: "Notes and summaries of your calls, written by AI" },
  vaultwarden: { task: "Passwords", line: "All your passwords in one safe place" },
  immich: { task: "Photos", line: "Phone photos backed up, like Google Photos" },
  lychee: { task: "Photo albums", line: "Simple photo albums to share with family" },
  jellyfin: { task: "Movies & music", line: "Your movies and music, like Netflix" },
  "wg-easy": { task: "VPN", line: "Private VPN through your own computer", product: "WireGuard" },
  chat: { task: "Team chat", line: "Private messenger for family or team", product: "Matrix" },
  "open-webui": { task: "AI chat", line: "Your own ChatGPT for family or team" },
  n8n: { task: "Automations", line: "Automate routine work, like Zapier" },
  "uptime-kuma": { task: "Site monitoring", line: "Get a message when a website goes down" },
  docmost: { task: "Wiki & docs", line: "Team wiki and docs, like Notion" },
  vikunja: { task: "To-do lists", line: "To-do lists and project boards" },
  memos: { task: "Quick notes", line: "Jot down a thought in a second" },
  actual: { task: "Budget", line: "Budget and spending under control" },
  "pingvin-share": { task: "Send big files", line: "Send big files by link" },
  paperless: { task: "Paper documents", line: "Scan once, find any document later" },
  easyappointments: { task: "Booking page", line: "Let clients book a time, like Calendly" },
  ghost: { task: "Blog & newsletter", line: "Blog, website and newsletter" },
  espocrm: { task: "Clients & deals", line: "Clients and deals in one place" },
  "static-site": { task: "Website", line: "A simple website with its own address" },
  "filebrowser-quantum": { task: "File browser", line: "Browse and share this computer's files" },
  // Not in the catalog yet.
  onlyoffice: { task: "Office documents", line: "Edit documents, sheets and slides together" },
  plausible: { task: "Site analytics", line: "Who visits your site, without cookies" },
  umami: { task: "Site analytics", line: "Who visits your site, without cookies" },
  gitea: { task: "Code & Git", line: "Your own place for code, like GitHub" },
  forgejo: { task: "Code & Git", line: "Your own place for code, like GitHub" },
  metabase: { task: "Charts & reports", line: "Charts and dashboards from your data" },
  nocodb: { task: "Tables & databases", line: "Spreadsheets that work like a database" },
  baserow: { task: "Tables & databases", line: "Spreadsheets that work like a database" },
  element: { task: "Team chat", line: "Private messenger for family or team" },
};

export interface AppDisplayName {
  /** What to show large: the task name, or the app's own name when it has none. */
  readonly title: string;
  /** The product name to show small and muted; null when the title is already it. */
  readonly product: string | null;
  /** The one-line task description; null when the map has none. */
  readonly line: string | null;
}

/** The task and product names of an app by its catalog id (null/unknown → its own name). */
export function appDisplayName(
  templateId: string | null | undefined,
  name: string,
): AppDisplayName {
  const entry = templateId ? APP_TASKS[templateId] : undefined;
  if (!entry) return { title: name, product: null, line: null };
  const product = entry.product ?? name;
  return {
    title: entry.task,
    product: product.trim().toLowerCase() === entry.task.toLowerCase() ? null : product,
    line: entry.line,
  };
}

/** "Files & documents (Nextcloud)" — for prompts and tooltips, where one string is all there is. */
export function appFullName(templateId: string | null | undefined, name: string): string {
  const shown = appDisplayName(templateId, name);
  return shown.product ? `${shown.title} (${shown.product})` : shown.title;
}
