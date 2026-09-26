import { describe, expect, it } from "vitest";

import { APP_TASKS, appDisplayName, appFullName } from "./appTaskNames";

describe("app task names", () => {
  it("names catalog apps by their task, the product small beside it", () => {
    expect(appDisplayName("nextcloud", "Nextcloud")).toEqual({
      title: "Files & documents",
      product: "Nextcloud",
      line: "Your files on every device, like Google Drive",
    });
    expect(appDisplayName("vaultwarden", "Vaultwarden").title).toBe("Passwords");
    expect(appDisplayName("notetaker", "Notetaker").title).toBe("Meeting notes");
  });

  it("uses a cleaner product name when the catalog's has the task in it", () => {
    expect(appDisplayName("wg-easy", "VPN (WireGuard)")).toMatchObject({
      title: "VPN",
      product: "WireGuard",
    });
    expect(appDisplayName("chat", "Chat (Matrix)")).toMatchObject({
      title: "Team chat",
      product: "Matrix",
    });
  });

  it("keeps the name of apps it doesn't know, and of apps that already say what they do", () => {
    expect(appDisplayName(null, "my-bot")).toEqual({ title: "my-bot", product: null, line: null });
    expect(appDisplayName("uno-tasks", "Uno Tasks")).toEqual({
      title: "Uno Tasks",
      product: null,
      line: null,
    });
  });

  it("spells both names in one string for prompts", () => {
    expect(appFullName("immich", "Immich")).toBe("Photos (Immich)");
    expect(appFullName(undefined, "Notes")).toBe("Notes");
  });

  it("keeps every task name short and plain", () => {
    for (const [id, entry] of Object.entries(APP_TASKS)) {
      const words = entry.task.split(/\s+/).filter((w) => w !== "&");
      expect(words.length, id).toBeGreaterThanOrEqual(1);
      expect(words.length, id).toBeLessThanOrEqual(3);
      expect(entry.line.length, id).toBeLessThanOrEqual(60);
      expect(entry.line.endsWith("."), id).toBe(false);
    }
  });
});
