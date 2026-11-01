import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ChannelFailure,
  MAX_DATA_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  openComputerChannel,
  type CallHandler,
  type HelperFrame,
} from "./channel.ts";
import { startFakeConsole, waitFor, type FakeConsole } from "./fakeConsole.testkit.ts";

let fake: FakeConsole;

beforeEach(async () => {
  fake = await startFakeConsole();
});
afterEach(async () => {
  await fake.close();
});

const open = (
  overrides: { token?: string; idleCloseMs?: number; connectTimeoutMs?: number } = {},
) =>
  openComputerChannel({
    url: `${fake.baseUrl.replace(/^http/, "ws")}/api/v1/work/computers/c1/channel`,
    token: fake.token,
    ...overrides,
  });

/** A call's frames and its end, for assertions. */
const watcher = () => {
  const frames: Array<HelperFrame> = [];
  const failures: Array<ChannelFailure> = [];
  const handler: CallHandler = {
    onFrame: (frame) => frames.push(frame),
    onClosed: (failure) => failures.push(failure),
  };
  return { frames, failures, handler };
};

describe("the channel to a computer", () => {
  it("connects with the machine token in the Authorization header", async () => {
    const channel = open();
    await channel.ready;
    expect(fake.channels).toHaveLength(1);
    expect(fake.channels[0]!.authorization).toBe(`Bearer ${fake.token}`);
    expect(fake.channels[0]!.path).toBe("/api/v1/work/computers/c1/channel");
    channel.close();
  });

  it("a refused token or a refused upgrade reads as a computer that can't be reached", async () => {
    const startedAt = Date.now();
    await expect(open({ token: "wrong" }).ready).rejects.toMatchObject({ kind: "offline" });
    fake.refuseUpgrade = 503;
    const refused = open();
    await expect(refused.ready).rejects.toThrow(/asleep or offline/);
    expect(refused.isClosed()).toBe(true);
    // At once, not after the connect timeout: Node 22 sends no `close` here.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("calls sharing the socket get only their own frames, in any order", async () => {
    const channel = open();
    await channel.ready;
    const first = watcher();
    const second = watcher();
    const firstCall = channel.start({ op: "exec", cmd: "one" }, first.handler);
    const secondCall = channel.start({ op: "exec", cmd: "two" }, second.handler);
    expect(firstCall.id).not.toBe(secondCall.id);
    await waitFor(() => fake.frames().length === 2, "both frames");
    expect(fake.frames()[0]).toMatchObject({ id: firstCall.id, op: "exec", cmd: "one", v: 1 });

    const relay = fake.channels[0]!;
    relay.send({ id: secondCall.id, type: "out", data: "Mg==" });
    relay.send({ id: firstCall.id, type: "out", data: "MQ==" });
    relay.send({ id: secondCall.id, type: "exit", code: 2 });
    relay.send({ id: "unknown", type: "out", data: "eA==" });
    await waitFor(() => second.frames.length === 2 && first.frames.length === 1, "the replies");

    expect(first.frames.map((frame) => frame.data)).toEqual(["MQ=="]);
    expect(second.frames.map((frame) => frame.type)).toEqual(["out", "exit"]);
    channel.close();
  });

  it("takes a numeric id back and ignores what isn't a frame", async () => {
    const channel = open();
    await channel.ready;
    const call = watcher();
    const { id } = channel.start({ op: "info" }, call.handler);
    const relay = fake.channels[0]!;
    relay.sendText("not json");
    relay.sendText("[1,2]");
    relay.send({ type: "hello", name: "Work laptop" });
    relay.send({ id: Number(id), type: "result", ok: true });
    await waitFor(() => call.frames.length === 1, "the result");
    expect(call.frames[0]).toMatchObject({ id, type: "result", ok: true });
    expect(channel.isClosed()).toBe(false);
    channel.close();
  });

  it("drops frames of a call that ended", async () => {
    const channel = open();
    await channel.ready;
    const call = watcher();
    const started = channel.start({ op: "info" }, call.handler);
    started.end();
    started.send({ op: "kill" });
    fake.channels[0]!.send({ id: started.id, type: "result" });
    const marker = watcher();
    const next = channel.start({ op: "stat", path: "/" }, marker.handler);
    fake.channels[0]!.send({ id: next.id, type: "result" });
    await waitFor(() => marker.frames.length === 1, "the next call");
    expect(call.frames).toEqual([]);
    expect(fake.frames().some((frame) => frame.op === "kill")).toBe(false);
    channel.close();
  });

  it("a closed channel ends every waiting call with the reason", async () => {
    const channel = open();
    await channel.ready;
    const first = watcher();
    const second = watcher();
    channel.start({ op: "exec", cmd: "one" }, first.handler);
    channel.start({ op: "exec", cmd: "two" }, second.handler);
    await waitFor(() => fake.frames().length === 2, "both frames");
    fake.channels[0]!.close(4001, "helper went away");
    await waitFor(() => second.failures.length === 1, "the failure");

    expect(first.failures).toHaveLength(1);
    expect(first.failures[0]!.kind).toBe("closed");
    expect(first.failures[0]!.message).toContain("helper went away");
    expect(first.failures[0]!.message).toContain("ask the person to open it");
    expect(channel.isClosed()).toBe(true);
    expect(() => channel.start({ op: "info" }, watcher().handler)).toThrow(ChannelFailure);
  });

  it("a connection that just dies does the same", async () => {
    const channel = open();
    await channel.ready;
    const call = watcher();
    channel.start({ op: "exec", cmd: "one" }, call.handler);
    await waitFor(() => fake.frames().length === 1, "the frame");
    fake.channels[0]!.drop();
    await waitFor(() => call.failures.length === 1, "the failure");
    expect(call.failures[0]!.kind).toBe("closed");
  });

  it("`revoked` and a channel-wide `error` from the console end it too", async () => {
    const revokedChannel = open();
    await revokedChannel.ready;
    const revoked = watcher();
    revokedChannel.start({ op: "info" }, revoked.handler);
    fake.channels[0]!.send({ type: "revoked" });
    await waitFor(() => revoked.failures.length === 1, "revoked");
    expect(revoked.failures[0]!.kind).toBe("revoked");
    expect(revoked.failures[0]!.message).toContain("disconnected this computer");

    const offlineChannel = open();
    await offlineChannel.ready;
    const offline = watcher();
    offlineChannel.start({ op: "info" }, offline.handler);
    fake.channels[1]!.send({ type: "error", code: "offline", message: "Computer went offline." });
    await waitFor(() => offline.failures.length === 1, "offline");
    expect(offline.failures[0]).toMatchObject({
      kind: "offline",
      message: "Computer went offline.",
    });
  });

  it("closes after a quiet while, and only with no call waiting", async () => {
    const channel = open({ idleCloseMs: 40 });
    await channel.ready;
    const call = watcher();
    const started = channel.start({ op: "exec", cmd: "long" }, call.handler);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(channel.isClosed()).toBe(false);

    started.end();
    await waitFor(() => channel.isClosed(), "the idle close");
    await waitFor(() => fake.channels[0]!.closed(), "the socket to go");
    expect(call.failures).toEqual([]);
  });

  it("refuses a frame over the limit; a full data chunk fits", async () => {
    const channel = open();
    await channel.ready;
    const call = watcher();
    const fullChunk = Buffer.alloc(MAX_DATA_CHUNK_BYTES, 1).toString("base64");
    expect(fullChunk.length).toBe(256 * 1024);
    channel.start({ op: "write", path: "/a", data: fullChunk }, call.handler);
    await waitFor(() => fake.frames().length === 1, "the big frame");
    expect((fake.frames()[0]!.data as string).length).toBe(fullChunk.length);

    expect(() =>
      channel.start({ op: "write", data: "x".repeat(MAX_FRAME_BYTES) }, watcher().handler),
    ).toThrow(RangeError);
    channel.close();
  });
});
