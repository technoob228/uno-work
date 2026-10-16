/**
 * Connectors as one list (Settings → Connectors, the teammate's access): the
 * four apps of the Uno account (OAuth, the console keeps the grant; tools in
 * the built-in `uno-work` MCP server) and servers of your own
 * (`settings.mcpServers`). Each with a plain line for everyone and a
 * technical one under "Details".
 *
 * Pure part only.
 */

export type ConnectorKind = "app" | "own";

export interface ConnectorItem {
  /** "github" for an app, "mcp:<name>" for a server of your own. */
  readonly id: string;
  readonly kind: ConnectorKind;
  readonly name: string;
  readonly connected: boolean;
  readonly account: string | null;
  /** What it lets the AI do, in plain words. */
  readonly plain: string;
  /** For the technical reader: where the tools come from and what the grant allows. */
  readonly tech: string;
}

/** What each app's grant covers — the scopes the console asks for. */
export const APP_TECH: Readonly<Record<string, { readonly plain: string; readonly tech: string }>> =
  {
    github: {
      plain: "Repos, issues and pull requests.",
      tech: "OAuth · scopes repo, read:org · MCP uno-work › github_* (28 tools)",
    },
    "google-drive": {
      plain: "Reads your files and saves new ones.",
      tech: "OAuth · scope drive.file · MCP uno-work › drive_* (9 tools)",
    },
    notion: {
      plain: "Pages and databases you share with Uno.",
      tech: "OAuth · read and update content · MCP uno-work › notion_* (12 tools)",
    },
    gmail: {
      plain: "Reads mail, drafts replies, sees your day.",
      tech: "OAuth · scopes gmail.modify, calendar.readonly · MCP uno-work › gmail_*, calendar_*",
    },
  };

export const MCP_ID_PREFIX = "mcp:";

export function connectorItems(input: {
  readonly apps: ReadonlyArray<{
    readonly provider: string;
    readonly name: string;
    readonly connected: boolean;
    readonly account: string | null;
    readonly needsReconnect?: boolean | undefined;
  }>;
  readonly servers: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
    readonly enabled?: boolean;
  }>;
}): ReadonlyArray<ConnectorItem> {
  return [
    ...input.apps.map((app) => ({
      id: app.provider,
      kind: "app" as const,
      name: app.name,
      connected: app.connected && app.needsReconnect !== true,
      account: app.account,
      plain: APP_TECH[app.provider]?.plain ?? "",
      tech: APP_TECH[app.provider]?.tech ?? "OAuth",
    })),
    ...input.servers
      .filter((server) => server.enabled !== false)
      .map((server) => ({
        id: `${MCP_ID_PREFIX}${server.name}`,
        kind: "own" as const,
        name: server.name,
        connected: true,
        account: null,
        plain: "A tool server you added.",
        tech: `MCP · ${server.url}`,
      })),
  ];
}

/** "GitHub and Google Drive are connected" / "Nothing connected yet". */
export function connectedSummary(items: ReadonlyArray<ConnectorItem>): string {
  const names = items.filter((item) => item.connected).map((item) => item.name);
  if (names.length === 0) return "Nothing connected yet.";
  if (names.length === 1) return `${names[0]} is connected.`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are connected.`;
}

/** A vault entry is a site login when it has a web address; else a key or token. */
export function isSiteLogin(entry: { readonly url: string }): boolean {
  return /^https?:\/\//.test(entry.url.trim());
}

export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
