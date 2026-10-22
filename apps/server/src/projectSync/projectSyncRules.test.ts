import { describe, expect, it } from "vitest";

import {
  TRIGGER_DELAY_MS,
  createSyncScheduler,
  envNames,
  envValue,
  mergeEnvContent,
} from "./projectSyncRules.ts";

/** Timers that move only when told to. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    timers: {
      setTimeout: (run: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, run });
        return id;
      },
      clearTimeout: (handle: unknown) => void pending.delete(handle as number),
      now: () => now,
    },
    advance: async (ms: number) => {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= until)
          .toSorted(([, a], [, b]) => a.at - b.at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await flush();
      }
      now = until;
      await flush();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("sync scheduler", () => {
  it("waits for the folder to be quiet: each save restarts the wait", async () => {
    const clock = fakeTimers();
    const runs: string[] = [];
    const scheduler = createSyncScheduler({
      run: async (key) => void runs.push(key),
      timers: clock.timers,
    });
    scheduler.schedule("p", "file-save");
    await clock.advance(10_000);
    scheduler.schedule("p", "file-save");
    await clock.advance(10_000);
    expect(runs).toEqual([]);
    await clock.advance(TRIGGER_DELAY_MS["file-save"]);
    expect(runs).toEqual(["p"]);
  });

  it("an agent's turn end syncs soon, merging with a pending save", async () => {
    const clock = fakeTimers();
    const runs: string[] = [];
    const scheduler = createSyncScheduler({
      run: async (key) => void runs.push(key),
      timers: clock.timers,
    });
    scheduler.schedule("p", "file-save");
    scheduler.schedule("p", "turn-end");
    await clock.advance(TRIGGER_DELAY_MS["turn-end"]);
    expect(runs).toEqual(["p"]);
    await clock.advance(60_000);
    expect(runs).toEqual(["p"]);
  });

  it("never runs one project twice at once; a trigger meanwhile asks for exactly one more run", async () => {
    const clock = fakeTimers();
    let release: (() => void) | null = null;
    let running = 0;
    let most = 0;
    let runs = 0;
    const scheduler = createSyncScheduler({
      run: () =>
        new Promise<void>((resolve) => {
          running += 1;
          most = Math.max(most, running);
          runs += 1;
          release = () => {
            running -= 1;
            resolve();
          };
        }),
      timers: clock.timers,
    });
    scheduler.schedule("p", "manual");
    expect(scheduler.isRunning("p")).toBe(true);
    scheduler.schedule("p", "manual");
    scheduler.schedule("p", "poll");
    scheduler.schedule("p", "opened");
    (release as unknown as () => void)();
    await flush();
    expect(runs).toBe(2);
    (release as unknown as () => void)();
    await flush();
    expect(runs).toBe(2);
    expect(most).toBe(1);
    expect(scheduler.lastFinishedAt("p")).toBe(0);
  });

  it("runNow waits for a run that started after it was asked", async () => {
    const clock = fakeTimers();
    const order: string[] = [];
    let release: (() => void) | null = null;
    const scheduler = createSyncScheduler({
      run: () =>
        new Promise<void>((resolve) => {
          order.push("run");
          release = resolve;
        }),
      timers: clock.timers,
    });
    scheduler.schedule("p", "manual");
    const waited = scheduler.runNow("p").then(() => order.push("done"));
    (release as unknown as () => void)();
    await flush();
    expect(order).toEqual(["run", "run"]);
    (release as unknown as () => void)();
    await waited;
    expect(order).toEqual(["run", "run", "done"]);
  });

  it("cancel and stop drop what was waiting", async () => {
    const clock = fakeTimers();
    let runs = 0;
    const scheduler = createSyncScheduler({
      run: async () => void (runs += 1),
      timers: clock.timers,
    });
    scheduler.schedule("a", "app-start");
    scheduler.cancel("a");
    scheduler.schedule("b", "file-save");
    scheduler.stop();
    await clock.advance(120_000);
    expect(runs).toBe(0);
  });
});

describe("keys into .env", () => {
  it("adds and updates the vault's keys, keeps keys only this computer has and the comments", () => {
    const local = '# my settings\nLOCAL_ONLY=1\nexport API_KEY=old\nQUOTED="a b"\n';
    const merged = mergeEnvContent(local, { API_KEY: "new", TOKEN: "t 1", QUOTED: "a b" });
    expect(merged.added).toEqual(["TOKEN"]);
    expect(merged.updated).toEqual(["API_KEY"]);
    expect(merged.content).toBe(
      '# my settings\nLOCAL_ONLY=1\nAPI_KEY=new\nQUOTED="a b"\nTOKEN="t 1"\n',
    );
    expect(envValue(merged.content, "TOKEN")).toBe("t 1");
    expect(envNames(merged.content)).toEqual(["LOCAL_ONLY", "API_KEY", "QUOTED", "TOKEN"]);
  });

  it("never writes a name that changes how programs start", () => {
    const merged = mergeEnvContent("", {
      NODE_OPTIONS: "--require evil",
      LD_PRELOAD: "x",
      OK: "1",
    });
    expect(merged.content).toBe("OK=1\n");
  });

  it("nothing new: the file stays byte for byte", () => {
    const local = "A=1\n# c\nB=two words # not a comment for quoted\n";
    expect(mergeEnvContent(local, { A: "1" }).content).toBe(local);
  });
});
