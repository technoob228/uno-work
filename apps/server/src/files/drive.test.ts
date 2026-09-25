import { describe, expect, it } from "vitest";

import { ControlPlaneHttpError } from "../workspaceRegistry/unoCloudParse.ts";
import type { CloudDeps } from "./cloudStorage.ts";
import {
  describeDriveError,
  driveBotConnect,
  driveSearch,
  driveShareCreate,
  driveShareRevoke,
  driveState,
  driveTelegramLink,
} from "./drive.ts";

function fakeConsole(routes: Record<string, (init?: RequestInit) => unknown>) {
  const calls: string[] = [];
  const deps: CloudDeps = {
    token: "machine-token",
    fetchJson: async (token, path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (token !== "machine-token") throw new ControlPlaneHttpError(401, "401: nope");
      const route = routes[`${init?.method ?? "GET"} ${path}`];
      if (!route) throw new ControlPlaneHttpError(404, "404 page not found");
      return route(init);
    },
  };
  return { deps, calls };
}

describe("Uno Drive client", () => {
  it("reads the console's state", async () => {
    const { deps } = fakeConsole({
      "GET /api/v1/drive": () => ({
        bucket_id: 12,
        bucket_name: "drive",
        used_bytes: 2048,
        quota_bytes: 25 * 1024 ** 3,
        telegram: {
          shared_bot: "get_uno_bot",
          shared_bot_ready: true,
          own_bot: { id: 3, username: "my_bot", connected_at: "2026-09-25T00:00:00Z" },
          own_bots_available: true,
          links: [
            {
              id: 1,
              bot_id: 0,
              chat_id: 5,
              telegram_user_id: 5,
              telegram_username: "misha",
              created_at: "2026-09-25T00:00:00Z",
            },
          ],
          download_limit_bytes: 20971520,
        },
      }),
    });
    const state = await driveState(deps);
    expect(state.available).toBe(true);
    expect(state.bucketId).toBe(12);
    expect(state.telegram.ownBot).toEqual({ id: 3, username: "my_bot" });
    expect(state.telegram.chats).toEqual([
      { id: 1, botId: 0, username: "misha", linkedAt: "2026-09-25T00:00:00Z" },
    ]);
  });

  it("searches, and skips the call for an empty query", async () => {
    const { deps, calls } = fakeConsole({
      "GET /api/v1/drive/search?q=%D0%B4%D0%BE%D0%B3%D0%BE%D0%B2%D0%BE%D1%80&limit=50&smart=1":
        () => ({
          files: [
            {
              key: "Telegram/2026-09/договор.pdf",
              name: "договор.pdf",
              size: 10,
              last_modified: "2026-09-25T00:00:00Z",
            },
          ],
          smart: true,
        }),
    });
    expect(await driveSearch(deps, { query: "  " })).toEqual({ files: [], smart: false });
    const result = await driveSearch(deps, { query: "договор", smart: true });
    expect(result.smart).toBe(true);
    expect(result.files[0]).toMatchObject({ key: "Telegram/2026-09/договор.pdf", size: 10 });
    expect(calls).toHaveLength(1);
  });

  it("creates share links and Telegram links", async () => {
    const { deps } = fakeConsole({
      "POST /api/v1/drive/shares": (init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toEqual({ key: "a.pdf", expires_in_hours: 24, via: "agent" });
        return {
          id: 9,
          key: "a.pdf",
          url: "https://console.uno4.dev/api/v1/drive/d/tok",
          expires_at: "2026-09-26T00:00:00Z",
          downloads: 0,
          created_via: "agent",
        };
      },
      "POST /api/v1/drive/telegram/link": () => ({
        url: "https://t.me/get_uno_bot?start=drive_abc",
        expires_at: "2026-09-25T00:15:00Z",
      }),
      "DELETE /api/v1/drive/shares/9": () => ({ ok: true }),
    });
    const share = await driveShareCreate(deps, { key: "a.pdf", expiresInHours: 24, via: "agent" });
    expect(share.url).toBe("https://console.uno4.dev/api/v1/drive/d/tok");
    expect((await driveTelegramLink(deps, {})).url).toContain("start=drive_");
    expect(await driveShareRevoke(deps, 9)).toEqual({ ok: true });
  });

  it("explains console refusals in words", async () => {
    const { deps } = fakeConsole({
      "PUT /api/v1/drive/telegram/bot": () => {
        throw new ControlPlaneHttpError(
          400,
          '400: {"detail":"Telegram didn\'t accept this token. Copy it again from @BotFather.","error":"INVALID_BOT_TOKEN"}',
        );
      },
    });
    await expect(driveBotConnect(deps, "123:x")).rejects.toThrow("Copy it again from @BotFather");
    expect(describeDriveError(new ControlPlaneHttpError(404, "404 page not found"))).toContain(
      "isn't available on this Uno console",
    );
    expect(
      describeDriveError(new ControlPlaneHttpError(402, '402: {"error":"STORAGE_QUOTA_EXCEEDED"}')),
    ).toContain("full");
  });
});
