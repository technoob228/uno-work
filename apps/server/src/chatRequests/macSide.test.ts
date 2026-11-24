import { describe, expect, it } from "vitest";

import {
  commandLine,
  MAC_SIDE_STATE_TTL_MS,
  macSideRefusal,
  macSideStateOf,
  makeMacSide,
} from "./macSide.ts";
import { helperCommandGroups, parsePs, stopCloudAgentCommands } from "./stopCloudAgents.ts";

const state = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    allow: true,
    active: 0,
    limit: 3,
    seenAt: "2026-11-23T10:00:00.000Z",
    app: "uno-work",
    ...over,
  });

describe("the person's switch for cloud agents, on their computer", () => {
  it("is absent without Uno Work there: everything as before", () => {
    expect(macSideStateOf(null)).toEqual({ kind: "absent" });
    expect(macSideRefusal({ kind: "absent" }, "Mac")).toBeNull();
  });

  it("lets calls through when on", () => {
    expect(macSideRefusal(macSideStateOf(state()), "Mac")).toBeNull();
  });

  it("refuses when off, and says where to turn it on", () => {
    const refusal = macSideRefusal(macSideStateOf(state({ allow: false })), "Mac");
    expect(refusal).toContain("Settings → Computer → Cloud agents");
  });

  it("says the person pressed Stop", () => {
    const refusal = macSideRefusal(
      macSideStateOf(state({ allow: false, stoppedAt: "2026-11-23T10:00:00.000Z" })),
      "Mac",
    );
    expect(refusal).toContain("Stop cloud agents");
  });

  it("counts a file it can't read as off", () => {
    expect(macSideStateOf("{not json")).toEqual({ kind: "present", allow: false, stoppedAt: null });
    expect(macSideStateOf(JSON.stringify({ hello: 1 })).kind).toBe("present");
    expect(macSideRefusal(macSideStateOf("{not json"), "Mac")).not.toBeNull();
  });

  it("reads the switch at most every few seconds per computer", async () => {
    let now = 0;
    let reads = 0;
    const side = makeMacSide({
      read: async () => {
        reads += 1;
        return state();
      },
      append: async () => undefined,
      nowMs: () => now,
    });
    await side.state("mac-1");
    await side.state("mac-1");
    expect(reads).toBe(1);
    await side.state("mac-2");
    expect(reads).toBe(2);
    now = MAC_SIDE_STATE_TTL_MS + 1;
    await side.state("mac-1");
    expect(reads).toBe(3);
  });

  it("writes one JSON line per command, clipped", async () => {
    const written: Array<string> = [];
    const side = makeMacSide({
      read: async () => state(),
      append: async (_id, path, text) => {
        expect(path).toBe("~/.uno-work/chat-requests/commands.jsonl");
        written.push(text);
      },
    });
    await side.log(
      "mac-1",
      commandLine({
        kind: "run",
        summary: "x".repeat(2000),
        outcome: "ran",
        tier: "chat",
        threadTitle: "Bakery site",
        threadId: "t-1",
        at: new Date("2026-11-23T10:00:00.000Z"),
        from: "uno-work",
      }),
    );
    expect(written).toHaveLength(1);
    expect(written[0]!.endsWith("\n")).toBe(true);
    const line = JSON.parse(written[0]!);
    expect(line.summary.length).toBe(600);
    expect(line).toMatchObject({ outcome: "ran", computerName: "uno-work", threadId: "t-1" });
  });
});

const PS = `
    1     0     1 /sbin/launchd
  500     1   500 /Applications/Uno Work.app/Contents/MacOS/uno-connect
  501   500   501 /bin/zsh
  502   501   501 npm
  510   500   510 /bin/bash
  600     1   600 /usr/bin/vim
  700     1   700 /Users/me/.uno/bin/uno-connect
  701   700   700 helper-thread
`;

describe("stop cloud agents, on the person's computer", () => {
  it("finds the process groups the helper started, never its own or others", () => {
    const rows = parsePs(PS);
    expect(rows).toHaveLength(8);
    expect(helperCommandGroups(rows).toSorted()).toEqual([501, 510]);
  });

  it("sends TERM, then KILL to what is left", async () => {
    const sent: Array<[number, string]> = [];
    let lists = 0;
    const count = await stopCloudAgentCommands({
      list: async () => {
        lists += 1;
        // After TERM: the bash one is gone, the zsh one is still there.
        return lists === 1 ? PS : PS.replace(/^\s*510 .*$/m, "");
      },
      signal: (pgid, signal) => {
        sent.push([pgid, signal]);
        return true;
      },
      graceMs: 1,
    });
    expect(count).toBe(2);
    expect(sent).toEqual([
      [501, "SIGTERM"],
      [510, "SIGTERM"],
      [501, "SIGKILL"],
    ]);
  });
});
