import { describe, expect, it } from "vitest";

import {
  type DeviceSlackDeps,
  type DeviceSlackSyncBody,
  type DeviceSlackSyncResult,
  deviceSlackDeliveryLine,
  readDeviceSlack,
  removeDeviceSlack,
  startDeviceSlack,
} from "./deviceSlack";

const SLR = "slr_" + "b".repeat(64);

class SignIn extends Error {}
class Refused extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function harness(input: {
  readonly console: Record<string, unknown>;
  readonly serverHasRelay?: boolean;
  readonly accountError?: Error;
}) {
  const calls: Array<string> = [];
  const syncs: Array<DeviceSlackSyncBody> = [];
  let hasRelay = input.serverHasRelay ?? false;
  const deps: DeviceSlackDeps = {
    account: async (method, path) => {
      calls.push(`${method} ${path}`);
      if (input.accountError) throw input.accountError;
      if (path === "/api/v1/work/slack/device") return method === "GET" ? input.console : null;
      if (path === "/api/v1/work/slack/device/relay") return { relay_token: SLR };
      if (path === "/api/v1/work/slack/device/install") {
        return {
          available: true,
          authorize_url: "https://console.test/api/v1/work/slack/oauth/start?state=x",
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    sync: async (body): Promise<DeviceSlackSyncResult> => {
      syncs.push(body);
      if (body.relayToken) hasRelay = true;
      const installed = body.installed;
      return {
        available: body.available,
        installed,
        teamName: body.teamName,
        botUserName: body.botUserName,
        connected: installed && hasRelay,
        installerDmReady: installed && hasRelay,
        needsRelay: installed && !hasRelay,
        ...(installed && hasRelay
          ? {
              routing: {
                computers: [],
                isDefault: true,
                defaultChosen: false,
                shared: false,
                signedAs: null,
              },
            }
          : {}),
      };
    },
    forget: async (projectId) => {
      calls.push(`forget ${projectId}`);
    },
    isSignInRequired: (error) => error instanceof SignIn,
    statusOf: (error) => (error instanceof Refused ? error.status : null),
  };
  return { deps, calls, syncs };
}

const installedAnswer = {
  available: true,
  installed: true,
  team_name: "Acme",
  bot_user_name: "uno",
  installer_user_id: "UINST",
  device: true,
  queue_ttl_hours: 24,
};

describe("readDeviceSlack", () => {
  it("mints a relay token only when the local server asks for one", async () => {
    const h = harness({ console: installedAnswer });
    const state = await readDeviceSlack(h.deps, "assistant-home");
    expect(state).toEqual({
      available: true,
      installed: true,
      teamName: "Acme",
      botUserName: "uno",
      connected: true,
      device: true,
      queueTtlHours: 24,
      signInRequired: false,
      routing: {
        computers: [],
        isDefault: true,
        defaultChosen: false,
        shared: false,
        signedAs: null,
      },
    });
    expect(h.calls).toEqual([
      "GET /api/v1/work/slack/device",
      "POST /api/v1/work/slack/device/relay",
    ]);
    expect(h.syncs).toHaveLength(2);
    expect(h.syncs[0]).not.toHaveProperty("relayToken");
    expect(h.syncs[1]).toMatchObject({ installerUserId: "UINST", relayToken: SLR });
    expect(h.syncs[0]).toMatchObject({ relayFingerprint: null });

    // Already on the relay: no second token (it would rotate the first away).
    const again = harness({ console: installedAnswer, serverHasRelay: true });
    await readDeviceSlack(again.deps, "assistant-home");
    expect(again.calls).toEqual(["GET /api/v1/work/slack/device"]);
  });

  it("doesn't touch the relay while nothing is installed", async () => {
    const h = harness({ console: { available: true, installed: false, device: true } });
    const state = await readDeviceSlack(h.deps, "assistant-home");
    expect(state).toMatchObject({
      available: true,
      installed: false,
      connected: false,
      device: true,
    });
    expect(h.calls).toEqual(["GET /api/v1/work/slack/device"]);
  });

  it("asks to sign in when the desktop has no Uno account", async () => {
    const h = harness({ console: {}, accountError: new SignIn() });
    expect(await readDeviceSlack(h.deps, "assistant-home")).toMatchObject({
      available: false,
      signInRequired: true,
      device: true,
    });
    expect(h.syncs).toHaveLength(0);
  });

  it("passes other console failures on", async () => {
    const h = harness({ console: {}, accountError: new Refused(500) });
    await expect(readDeviceSlack(h.deps, "assistant-home")).rejects.toThrow("HTTP 500");
  });
});

describe("startDeviceSlack / removeDeviceSlack", () => {
  it("returns the console's link, or available:false when Uno's app isn't set up", async () => {
    const h = harness({ console: {} });
    expect(await startDeviceSlack(h.deps)).toEqual({
      available: true,
      authorizeUrl: "https://console.test/api/v1/work/slack/oauth/start?state=x",
    });
    const off = harness({ console: {}, accountError: new Refused(503) });
    expect(await startDeviceSlack(off.deps)).toEqual({ available: false, authorizeUrl: null });
  });

  it("removes at the console first, then forgets the relay here", async () => {
    const h = harness({ console: {} });
    await removeDeviceSlack(h.deps, "assistant-home");
    expect(h.calls).toEqual(["DELETE /api/v1/work/slack/device", "forget assistant-home"]);
  });

  it("says how a laptop answers", () => {
    expect(deviceSlackDeliveryLine(24)).toBe(
      "Answers while Uno Work is open on this computer; messages wait up to 24 hours.",
    );
  });
});
