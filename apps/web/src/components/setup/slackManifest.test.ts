import * as FS from "node:fs";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import { SLACK_NEW_APP_URL } from "./SlackGuide";

/** "  - item" lines under a YAML key, up to the next key at the same depth. */
function yamlList(yaml: string, key: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s*-\s+(\S+)/.exec(line);
    if (!item) break;
    out.push(item[1]!);
  }
  return out;
}

describe("Create your own Slack bot", () => {
  const url = new URL(SLACK_NEW_APP_URL);
  const manifest = JSON.parse(url.searchParams.get("manifest_json") ?? "null") as {
    oauth_config: { scopes: { bot: string[] } };
    settings: { event_subscriptions: { bot_events: string[] }; socket_mode_enabled: boolean };
  };

  it("opens Slack's app builder with the manifest prefilled (manifest_json)", () => {
    expect(url.origin + url.pathname).toBe("https://api.slack.com/apps");
    expect(url.searchParams.get("new_app")).toBe("1");
    expect(manifest.settings.socket_mode_enabled).toBe(true);
  });

  it("asks for what docs/slack-app-manifest.yaml asks for", () => {
    const yaml = FS.readFileSync(
      Path.resolve(__dirname, "../../../../../docs/slack-app-manifest.yaml"),
      "utf8",
    );
    expect(yamlList(yaml, "bot").length).toBeGreaterThan(0);
    expect(manifest.oauth_config.scopes.bot).toEqual(yamlList(yaml, "bot"));
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(yamlList(yaml, "bot_events"));
  });
});
