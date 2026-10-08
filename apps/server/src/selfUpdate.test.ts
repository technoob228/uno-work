import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  SELF_UPDATE_BASE_URL_ENV,
  SELF_UPDATE_DEFAULT_BASE_URL,
  SELF_UPDATE_REQUEST_ENV,
  SELF_UPDATE_STATUS_ENV,
  SelfUpdateUnavailableError,
  isNewerVersion,
  makeSelfUpdateController,
  normalizeBaseUrl,
  parseLatestRelease,
  parseUpdaterStatus,
  selfUpdatePathsFromEnv,
} from "./selfUpdate.ts";
import {
  noteSelfUpdateIntent,
  reportSelfUpdate,
  reportSelfUpdateAfterStart,
  resetSelfUpdateReportState,
  selfUpdateReportFor,
  startedByOwner,
} from "./selfUpdateJournal.ts";

const SHA_111 = "6b64e8f412914c4faf507808d43fc98df2022d2c710effed1b279ef64787c4e1";
const SHA_112 = "7a3d3d22cacdcc83ac4c04e2eb58de101c6617248a502dc5bf01d3c4f743bd72";
const SHA_113 = "1111111111111111111111111111111111111111111111111111111111111111";

/** The real file on the console is append-only: every release adds two lines. */
const SUMS = [
  `${SHA_111}  uno-work-server-0.0.111.tar.gz`,
  `${SHA_111}  uno-work-server-latest.tar.gz`,
  `${SHA_112}  uno-work-server-0.0.112.tar.gz`,
  `${SHA_112}  uno-work-server-latest.tar.gz`,
  "",
].join("\n");

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "uno-self-update-"));
  mkdirSync(join(root, "status"), { recursive: true });
  return {
    root,
    paths: {
      requestFile: join(root, "state", "update", "request"),
      statusFile: join(root, "status", "status.json"),
      baseUrl: "https://console.uno.place/cli/work",
    },
  };
}

function sumsFetch(body: string, calls: string[] = []): typeof fetch {
  return (async (input: unknown) => {
    calls.push(String(input));
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("parseLatestRelease", () => {
  it("takes the last line for latest and the versioned file with the same sha", () => {
    expect(parseLatestRelease(SUMS)).toEqual({
      version: "0.0.112",
      sha256: SHA_112,
      tarball: "uno-work-server-0.0.112.tar.gz",
    });
  });

  it("a release uploaded next to latest but not promoted is not the latest", () => {
    const staged = `${SUMS}${SHA_113}  uno-work-server-0.0.113.tar.gz\n`;
    expect(parseLatestRelease(staged)?.version).toBe("0.0.112");
  });

  it("is null without a latest line or without a versioned twin", () => {
    expect(parseLatestRelease("")).toBeNull();
    expect(parseLatestRelease(`${SHA_113}  uno-work-server-0.0.113.tar.gz\n`)).toBeNull();
    expect(parseLatestRelease(`${SHA_113}  uno-work-server-latest.tar.gz\n`)).toBeNull();
  });

  it("ignores names that are not a plain X.Y.Z release", () => {
    const odd = [
      `${SHA_113}  uno-work-server-0.0.113-rc1.tar.gz`,
      `${SHA_113}  ../../evil.tar.gz`,
      `${SHA_113}  uno-work-server-latest.tar.gz`,
    ].join("\n");
    expect(parseLatestRelease(odd)).toBeNull();
  });
});

describe("normalizeBaseUrl", () => {
  it("https anywhere, plain http only on loopback, no credentials or query", () => {
    expect(normalizeBaseUrl("https://console.uno.place/cli/work/")).toBe(
      "https://console.uno.place/cli/work",
    );
    expect(normalizeBaseUrl("http://127.0.0.1:8099")).toBe("http://127.0.0.1:8099");
    expect(normalizeBaseUrl("http://example.com/cli/work")).toBeNull();
    expect(normalizeBaseUrl("https://user:pw@example.com/x")).toBeNull();
    expect(normalizeBaseUrl("https://example.com/x?y=1")).toBeNull();
    expect(normalizeBaseUrl("")).toBeNull();
  });
});

describe("selfUpdatePathsFromEnv", () => {
  it("is off unless both paths are set and absolute", () => {
    expect(selfUpdatePathsFromEnv({})).toBeNull();
    expect(
      selfUpdatePathsFromEnv({
        [SELF_UPDATE_REQUEST_ENV]: "request",
        [SELF_UPDATE_STATUS_ENV]: "/s",
      }),
    ).toBeNull();
    expect(
      selfUpdatePathsFromEnv({
        [SELF_UPDATE_REQUEST_ENV]: "/var/lib/uno-work/update/request",
        [SELF_UPDATE_STATUS_ENV]: "/var/lib/uno-work-update/status.json",
        [SELF_UPDATE_BASE_URL_ENV]: "http://evil.example/x",
      }),
    ).toEqual({
      requestFile: "/var/lib/uno-work/update/request",
      statusFile: "/var/lib/uno-work-update/status.json",
      baseUrl: SELF_UPDATE_DEFAULT_BASE_URL,
    });
  });
});

describe("isNewerVersion", () => {
  it("compares numerically", () => {
    expect(isNewerVersion("0.0.113", "0.0.112")).toBe(true);
    expect(isNewerVersion("0.0.112", "0.0.112")).toBe(false);
    expect(isNewerVersion("0.0.99", "0.0.112")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.0.112")).toBe(true);
  });
});

describe("parseUpdaterStatus", () => {
  it("reads what the updater writes and rejects anything else", () => {
    expect(parseUpdaterStatus("not json")).toBeNull();
    expect(parseUpdaterStatus(JSON.stringify({ state: "weird" }))).toBeNull();
    expect(
      parseUpdaterStatus(
        JSON.stringify({ state: "failed", error: "x", rolledBack: true, fromVersion: "0.0.113" }),
      ),
    ).toMatchObject({ state: "failed", error: "x", rolledBack: true, fromVersion: "0.0.113" });
  });
});

describe("self-update controller", () => {
  it("is not supported without the installer's paths", async () => {
    const controller = makeSelfUpdateController({ paths: null, currentVersion: "0.0.113" });
    const status = await controller.status({ canUpdate: true });
    expect(status).toMatchObject({ supported: false, available: false, canUpdate: false });
    await expect(controller.start()).rejects.toBeInstanceOf(SelfUpdateUnavailableError);
  });

  it("offers the console's latest when it is newer and asks the console once per TTL", async () => {
    const { paths } = dirs();
    const calls: string[] = [];
    const controller = makeSelfUpdateController({
      paths,
      currentVersion: "0.0.111",
      fetchImpl: sumsFetch(SUMS, calls),
    });
    const status = await controller.status({ canUpdate: false });
    expect(status).toMatchObject({
      supported: true,
      canUpdate: false,
      currentVersion: "0.0.111",
      latestVersion: "0.0.112",
      available: true,
      state: "idle",
    });
    await controller.status({ canUpdate: true });
    expect(calls).toEqual(["https://console.uno.place/cli/work/SHA256SUMS"]);
    await controller.status({ canUpdate: true, refresh: true });
    expect(calls).toHaveLength(2);
  });

  it("offers nothing when this is the latest, or when the console is unreachable", async () => {
    const { paths } = dirs();
    const current = makeSelfUpdateController({
      paths,
      currentVersion: "0.0.112",
      fetchImpl: sumsFetch(SUMS),
    });
    expect((await current.status({ canUpdate: true })).available).toBe(false);
    await expect(current.start()).rejects.toThrow("already up to date");

    const offline = makeSelfUpdateController({
      paths,
      currentVersion: "0.0.111",
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(await offline.status({ canUpdate: true })).toMatchObject({
      supported: true,
      available: false,
      latestVersion: null,
    });
  });

  it("start drops an empty-handed request file and reports 'updating'", async () => {
    const { paths } = dirs();
    const controller = makeSelfUpdateController({
      paths,
      currentVersion: "0.0.111",
      fetchImpl: sumsFetch(SUMS),
    });
    const status = await controller.start();
    expect(status).toMatchObject({ state: "updating", step: "Starting", available: false });
    // Only a timestamp: nothing the updater could be steered with.
    expect(readFileSync(paths.requestFile, "utf8")).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z\n$/);
    // A second press while it runs does not write again.
    const before = statSync(paths.requestFile).mtimeMs;
    expect((await controller.start()).state).toBe("updating");
    expect(statSync(paths.requestFile).mtimeMs).toBe(before);
  });

  it("follows the updater: updating → done / failed", async () => {
    const { paths } = dirs();
    const controller = makeSelfUpdateController({
      paths,
      currentVersion: "0.0.112",
      fetchImpl: sumsFetch(SUMS),
    });
    const now = new Date().toISOString();
    writeFileSync(
      paths.statusFile,
      JSON.stringify({
        state: "updating",
        step: "Downloading Uno Work 0.0.113",
        fromVersion: "0.0.112",
        toVersion: "0.0.113",
        startedAt: now,
        updatedAt: now,
      }),
    );
    expect(await controller.status({ canUpdate: true })).toMatchObject({
      state: "updating",
      step: "Downloading Uno Work 0.0.113",
      toVersion: "0.0.113",
    });
    writeFileSync(
      paths.statusFile,
      JSON.stringify({
        state: "failed",
        error:
          "Uno Work 0.0.113 didn't start within 120 seconds. This computer is back on Uno Work 0.0.112.",
        rolledBack: true,
        fromVersion: "0.0.112",
        toVersion: "0.0.113",
        startedAt: now,
        updatedAt: now,
        finishedAt: now,
      }),
    );
    expect(await controller.status({ canUpdate: true })).toMatchObject({
      state: "failed",
      rolledBack: true,
      finishedAt: now,
    });
    writeFileSync(
      paths.statusFile,
      JSON.stringify({
        state: "done",
        fromVersion: "0.0.111",
        toVersion: "0.0.112",
        finishedAt: now,
        updatedAt: now,
      }),
    );
    expect(await controller.status({ canUpdate: true })).toMatchObject({
      state: "done",
      toVersion: "0.0.112",
    });
  });

  it("says so when the request was never picked up", async () => {
    const { paths } = dirs();
    const controller = makeSelfUpdateController({
      paths,
      currentVersion: "0.0.111",
      fetchImpl: sumsFetch(SUMS),
    });
    await controller.start();
    const old = new Date(Date.now() - 3 * 60_000);
    utimesSync(paths.requestFile, old, old);
    expect(await controller.status({ canUpdate: true })).toMatchObject({
      state: "failed",
      error: "The update didn't start on this computer. Try again in a minute.",
    });
  });
});

describe("security journal report", () => {
  beforeEach(() => resetSelfUpdateReportState());

  const run = {
    state: "done" as const,
    step: null,
    error: null,
    fromVersion: "0.0.113",
    toVersion: "0.0.114",
    rolledBack: false,
    startedAt: "2026-10-08T10:00:05Z",
    updatedAt: "2026-10-08T10:02:00Z",
    finishedAt: "2026-10-08T10:02:00Z",
  };

  it("knows the owner's button from a stray request", () => {
    expect(startedByOwner(run, "2026-10-08T10:00:04.200Z")).toBe(true);
    // The updater writes whole seconds: the note can look a second "later".
    expect(startedByOwner(run, "2026-10-08T10:00:05.900Z")).toBe(true);
    expect(startedByOwner(run, "2026-10-08T09:00:00Z")).toBe(false);
    expect(startedByOwner(run, null)).toBe(false);
  });

  it("reports an update and a rollback, nothing else", () => {
    expect(selfUpdateReportFor(run, "2026-10-08T10:00:04Z")).toEqual({
      from_version: "0.0.113",
      to_version: "0.0.114",
      outcome: "updated",
      by_owner: true,
    });
    expect(selfUpdateReportFor({ ...run, state: "failed", rolledBack: true }, null)).toMatchObject({
      outcome: "rolled_back",
      by_owner: false,
    });
    expect(selfUpdateReportFor({ ...run, state: "failed", rolledBack: false }, null)).toBeNull();
    expect(selfUpdateReportFor({ ...run, state: "current" }, null)).toBeNull();
    expect(selfUpdateReportFor(null, null)).toBeNull();
  });

  it("posts once per finished run with the machine's own token", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "uno-self-update-journal-"));
    await noteSelfUpdateIntent(stateDir, Date.parse("2026-10-08T10:00:04Z"));
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response("{}", { status: 201 });
    };
    const input = {
      stateDir,
      lastRun: async () => run,
      identity: { boxToken: "uno_agt_test", boxId: 2494 },
      consoleBaseUrl: "https://console.example",
      fetchImpl,
    };
    await reportSelfUpdate(input);
    await reportSelfUpdate(input);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://console.example/api/v1/boxes/2494/security/work-update");
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      from_version: "0.0.113",
      to_version: "0.0.114",
      outcome: "updated",
      by_owner: true,
    });
    const headers = (requests[0]!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer uno_agt_test");
  });

  it("does nothing off a cloud computer and retries later after a console error", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "uno-self-update-journal-"));
    let calls = 0;
    let clock = 1_000_000;
    const base = {
      stateDir,
      lastRun: async () => run,
      consoleBaseUrl: "https://console.example",
      now: () => clock,
      fetchImpl: async () => {
        calls += 1;
        return new Response("", { status: calls === 1 ? 502 : 201 });
      },
    };
    await reportSelfUpdate({ ...base, identity: null });
    expect(calls).toBe(0);
    const identity = { boxToken: "t", boxId: 1 };
    await reportSelfUpdate({ ...base, identity });
    await reportSelfUpdate({ ...base, identity });
    expect(calls).toBe(1);
    clock += 6 * 60_000;
    await reportSelfUpdate({ ...base, identity });
    await reportSelfUpdate({ ...base, identity });
    expect(calls).toBe(2);
  });

  it("at daemon start, waits for the updater to finish checking it, then reports once", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "uno-self-update-journal-"));
    await noteSelfUpdateIntent(stateDir, Date.parse("2026-10-08T10:00:04Z"));
    // 08.10: the new daemon started at :49, the updater wrote finishedAt at :55.
    const checking = { ...run, state: "updating" as const, finishedAt: null };
    let reads = 0;
    let clock = 1_000_000;
    const slept: number[] = [];
    const requests: string[] = [];
    await reportSelfUpdateAfterStart({
      stateDir,
      lastRun: async () => {
        reads += 1;
        return reads <= 2 ? checking : run;
      },
      identity: { boxToken: "uno_agt_test", boxId: 2535 },
      consoleBaseUrl: "https://console.example",
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      fetchImpl: async (url, init) => {
        requests.push(String(init?.body));
        return new Response("{}", { status: 201 });
      },
    });
    expect(slept).toEqual([3_000, 3_000]);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!)).toEqual({
      from_version: "0.0.113",
      to_version: "0.0.114",
      outcome: "updated",
      by_owner: true,
    });
    // A later start (or the status route) does not post it again.
    await reportSelfUpdateAfterStart({
      stateDir,
      lastRun: async () => run,
      identity: { boxToken: "uno_agt_test", boxId: 2535 },
      consoleBaseUrl: "https://console.example",
      now: () => clock + 10 * 60_000,
      fetchImpl: async () => {
        requests.push("again");
        return new Response("{}", { status: 201 });
      },
    });
    expect(requests).toHaveLength(1);
  });

  it("at daemon start, gives up on an updater that never finishes and skips machines off the cloud", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "uno-self-update-journal-"));
    const stuck = { ...run, state: "updating" as const, finishedAt: null };
    let clock = 1_000_000;
    let posts = 0;
    let reads = 0;
    const base = {
      stateDir,
      lastRun: async () => {
        reads += 1;
        return stuck;
      },
      consoleBaseUrl: "https://console.example",
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      fetchImpl: async () => {
        posts += 1;
        return new Response("{}", { status: 201 });
      },
    };
    await reportSelfUpdateAfterStart({ ...base, identity: null });
    expect(reads).toBe(0);
    await reportSelfUpdateAfterStart({ ...base, identity: { boxToken: "t", boxId: 1 } });
    expect(posts).toBe(0);
    expect(clock - 1_000_000).toBe(10 * 60_000);
  });
});
