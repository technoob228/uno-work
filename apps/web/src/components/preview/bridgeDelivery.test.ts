import type { BrowserBridgeStreamEvent, EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  RESULT_POST_RETRY_DELAYS_MS,
  noteBridgeEventSeen,
  postBridgeResult,
  readBridgeResumeCursor,
  resetBridgeDeliveryForTests,
} from "./bridgeDelivery";

const ENV = "env-a" as EnvironmentId;
const open = (sequence: number) =>
  ({
    version: 1,
    type: "openUrl",
    sequence,
    url: "https://x.example/",
  }) as BrowserBridgeStreamEvent;
const secret = (sequence: number) =>
  ({ version: 1, type: "secretRequest", sequence }) as unknown as BrowserBridgeStreamEvent;

const response = (status: number) => ({ ok: status >= 200 && status < 300, status }) as Response;

beforeEach(() => resetBridgeDeliveryForTests());

describe("bridge resume cursor", () => {
  it("follows the last event seen, also back down after a server restart", () => {
    expect(readBridgeResumeCursor(ENV)).toBeNull();
    noteBridgeEventSeen(ENV, open(7));
    noteBridgeEventSeen(ENV, open(8));
    expect(readBridgeResumeCursor(ENV)).toBe(8);
    noteBridgeEventSeen(ENV, open(1));
    expect(readBridgeResumeCursor(ENV)).toBe(1);
  });

  it("re-sent open secret requests do not move it back", () => {
    noteBridgeEventSeen(ENV, open(12));
    noteBridgeEventSeen(ENV, secret(4));
    expect(readBridgeResumeCursor(ENV)).toBe(12);
    noteBridgeEventSeen(ENV, secret(13));
    expect(readBridgeResumeCursor(ENV)).toBe(13);
  });
});

describe("result POST", () => {
  it("retries network errors and 5xx, then succeeds", async () => {
    const outcomes: Array<() => Promise<Response>> = [
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => Promise.resolve(response(502)),
      () => Promise.resolve(response(200)),
    ];
    const slept: number[] = [];
    const accepted = await postBridgeResult("/r", "{}", {
      fetch: () => outcomes.shift()!(),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(accepted).toBe(true);
    expect(slept).toEqual(RESULT_POST_RETRY_DELAYS_MS.slice(0, 2));
  });

  it("stops on 404 (command already answered or timed out)", async () => {
    let calls = 0;
    const accepted = await postBridgeResult("/r", "{}", {
      fetch: () => {
        calls += 1;
        return Promise.resolve(response(404));
      },
      sleep: async () => undefined,
    });
    expect(accepted).toBe(false);
    expect(calls).toBe(1);
  });

  it("gives up after the last retry", async () => {
    let calls = 0;
    const accepted = await postBridgeResult("/r", "{}", {
      fetch: () => {
        calls += 1;
        return Promise.reject(new Error("timeout"));
      },
      sleep: async () => undefined,
    });
    expect(accepted).toBe(false);
    expect(calls).toBe(RESULT_POST_RETRY_DELAYS_MS.length + 1);
  });
});
