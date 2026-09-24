import { describe, expect, it } from "vitest";

import { parseHiddenApps } from "./hiddenApps.ts";
import {
  codeFolderFor,
  pickAppProcesses,
  pickAppUnits,
  stopProcesses,
  type ProcessInfo,
} from "./removeRegisteredApp.ts";

const home = "/home/unowork";
const context = {
  home,
  protectedDirs: [`${home}/.uno/apps`, `${home}/.uno/app-keys`, "/var/lib/uno-work"],
  others: [] as Array<{ id: string; name: string; cwd: string | null }>,
};

describe("codeFolderFor", () => {
  it("a folder of the app's own may be deleted", () => {
    expect(codeFolderFor({ id: "notes", cwd: `${home}/projects/notes` }, context)).toEqual({
      path: `${home}/projects/notes`,
      keepReason: null,
    });
    expect(codeFolderFor({ id: "notes", cwd: `${home}/notes-app` }, context)?.keepReason).toBe(
      null,
    );
  });

  it("no cwd, no folder", () => {
    expect(codeFolderFor({ id: "notes", cwd: null }, context)).toBeNull();
  });

  it("never home, folders that hold more than one thing, or the computer's own", () => {
    for (const cwd of [
      home,
      "/opt/notes",
      `${home}/projects`,
      `${home}/Documents`,
      `${home}/.hidden-tool`,
      `${home}/.uno/apps/x`,
      `${home}/.config/notes`,
    ]) {
      expect(codeFolderFor({ id: "notes", cwd }, context)?.keepReason, cwd).toBeTruthy();
    }
  });

  it("never a folder another app uses, above or below", () => {
    const withOthers = {
      ...context,
      others: [{ id: "album", name: "Album", cwd: `${home}/work-apps/album` }],
    };
    expect(
      codeFolderFor({ id: "notes", cwd: `${home}/work-apps/album` }, withOthers)?.keepReason,
    ).toMatch(/Album uses the same folder/);
    expect(
      codeFolderFor({ id: "notes", cwd: `${home}/work-apps` }, withOthers)?.keepReason,
    ).toMatch(/Album/);
    expect(
      codeFolderFor({ id: "notes", cwd: `${home}/work-apps/album/sub` }, withOthers)?.keepReason,
    ).toMatch(/Album/);
    expect(
      codeFolderFor({ id: "notes", cwd: `${home}/work-apps/notes` }, withOthers)?.keepReason,
    ).toBeNull();
  });
});

describe("pickAppProcesses", () => {
  const p = (patch: Partial<ProcessInfo> & { pid: number }): ProcessInfo => ({
    ppid: 1,
    uid: 1002,
    comm: "node",
    cwd: null,
    appMarker: null,
    ...patch,
  });

  it("the listener, marked processes and strays in its folder — not terminals, AI or others", () => {
    const table = [
      p({ pid: 500, ppid: 1, comm: "uno-work" }), // the daemon
      p({ pid: 10, cwd: `${home}/projects/notes` }), // listener
      p({ pid: 11, appMarker: "notes" }),
      p({ pid: 12, cwd: `${home}/projects/notes/worker` }),
      p({ pid: 13, ppid: 500, comm: "bash", cwd: `${home}/projects/notes` }), // Work terminal
      p({ pid: 14, ppid: 13, comm: "node", cwd: `${home}/projects/notes` }), // started from it
      p({ pid: 15, comm: "opencode", cwd: `${home}/projects/notes` }),
      p({ pid: 16, uid: 0, cwd: `${home}/projects/notes` }), // root's
      p({ pid: 17, appMarker: "album" }),
      p({ pid: 18, cwd: `${home}/projects/notes-old` }),
    ];
    expect(
      pickAppProcesses(table, {
        appId: "notes",
        selfPid: 500,
        uid: 1002,
        listenerPids: [10],
        codeDir: `${home}/projects/notes`,
      }),
    ).toEqual([10, 11, 12]);
  });

  it("without its own folder, only the listener and marked ones", () => {
    expect(
      pickAppProcesses([p({ pid: 10, cwd: home }), p({ pid: 20, cwd: home })], {
        appId: "notes",
        selfPid: 500,
        uid: 1002,
        listenerPids: [10],
        codeDir: null,
      }),
    ).toEqual([10]);
  });
});

describe("pickAppUnits", () => {
  const unit = (name: string, text = "") => ({ name, path: `/u/${name}`, text });

  it("named after the app, owning its port, or running from its folder — with their timers", () => {
    const units = [
      unit("notes.service"),
      unit("notes-digest.timer", "[Timer]\nOnCalendar=daily\n"),
      unit("notes-digest.service"),
      unit("report.timer", "[Timer]\nUnit=daily-report.service\n"),
      unit("daily-report.service", `[Service]\nWorkingDirectory=${home}/projects/notes\n`),
      unit("web.service"),
      unit("other.service", `[Service]\nExecStart=/usr/bin/node ${home}/projects/notes-old/a.js\n`),
      unit("notesy.service"),
    ];
    expect(
      pickAppUnits(units, {
        appId: "notes",
        codeDir: `${home}/projects/notes`,
        ownerUnits: ["web.service"],
        manifestPath: `${home}/.uno/apps/notes.json`,
      }).map((u) => u.name),
    ).toEqual([
      "notes.service",
      "notes-digest.timer",
      "notes-digest.service",
      "report.timer",
      "daily-report.service",
      "web.service",
    ]);
  });
});

describe("stopProcesses", () => {
  it("TERM first, KILL what stays", async () => {
    const alive = new Set([1, 2]);
    const signals: string[] = [];
    const left = await stopProcesses([1, 2], {
      graceMs: 200,
      kill: (pid, signal) => {
        signals.push(`${pid}:${signal}`);
        if (signal === "SIGKILL" || pid === 1) alive.delete(pid);
      },
      isAlive: (pid) => alive.has(pid),
    });
    expect(left).toEqual([]);
    expect(signals).toEqual(["1:SIGTERM", "2:SIGTERM", "2:SIGKILL"]);
  });
});

describe("parseHiddenApps", () => {
  it("reads the list and ignores junk", () => {
    expect([...parseHiddenApps('{"hidden":["port:8080",5,"",null]}')]).toEqual(["port:8080"]);
    expect(parseHiddenApps("not json").size).toBe(0);
    expect(parseHiddenApps(null).size).toBe(0);
  });
});
