import { describe, expect, it } from "vitest";

import { groupProcesses, type GroupingInput, type MeasuredProcess } from "./resourceGroups.ts";

const ME = 1002;
const SELF = 500;

function proc(
  pid: number,
  ppid: number,
  name: string,
  extra: Partial<MeasuredProcess> = {},
): MeasuredProcess {
  return {
    pid,
    ppid,
    uid: ME,
    name,
    command: name,
    exe: null,
    startToken: `l${pid}`,
    memMb: 10,
    cpuTicks: 0,
    cpuPctPerCore: null,
    kernelThread: false,
    cgroup: null,
    cpuPct: 1,
    ...extra,
  };
}

const DOCKER_ID = "a".repeat(64);

function input(processes: MeasuredProcess[], extra: Partial<GroupingInput> = {}): GroupingInput {
  return {
    platform: "linux",
    processes,
    selfPid: SELF,
    selfUid: ME,
    manifestApps: [],
    containers: null,
    dockerAccess: false,
    services: [],
    cwdByPid: new Map(),
    ...extra,
  };
}

const machine = [
  proc(1, 0, "systemd", { uid: 0 }),
  proc(2, 0, "kthreadd", { uid: 0, kernelThread: true }),
  proc(3, 2, "kworker/0:1", { uid: 0, kernelThread: true }),
  proc(400, 1, "systemd", { uid: ME }),
  proc(SELF, 1, "node", { command: "node /opt/uno-work/bin.mjs" }),
  proc(510, SELF, "node", {
    command: "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
  }),
  proc(511, 510, "npm", { command: "npm test", cpuPct: 60, memMb: 300 }),
  proc(520, SELF, "bash", { command: "bash" }),
  proc(521, 520, "python3", { command: "python3 train.py --api-key sk123" }),
  proc(530, SELF, "bash", { command: "bash -lc node app.js" }),
  proc(531, 530, "node", { command: "node app.js" }),
  proc(600, 1, "containerd-shim", { uid: 0 }),
  proc(601, 600, "node", {
    uid: 0,
    cgroup: `0::/system.slice/docker-${DOCKER_ID}.scope\n`,
  }),
  proc(700, 400, "notes", {
    cgroup: "0::/user.slice/user-1002.slice/user@1002.service/app.slice/notes.service\n",
  }),
  proc(800, 400, "htop"),
  proc(801, 1, "sshd", { uid: 0 }),
];

describe("groupProcesses", () => {
  const result = groupProcesses(
    input(machine, {
      manifestApps: [{ appId: "manifest:blog", name: "Blog", icon: "📝", listenerPid: 531 }],
      containers: new Map([
        [
          DOCKER_ID,
          {
            id: DOCKER_ID,
            name: "n8n",
            image: "n8nio/n8n:latest",
            machineAppId: "docker:n8n",
            displayName: "n8n",
          },
        ],
      ]),
      dockerAccess: true,
      services: [
        {
          unit: "notes.service",
          user: true,
          machineAppId: "systemd:user:notes.service",
          name: "notes",
          icon: null,
        },
      ],
      cwdByPid: new Map([[510, "/home/unowork/project"]]),
    }),
  );
  const byId = new Map(result.groups.map((g) => [g.id, g]));
  const groupOf = (pid: number) => result.groupOfPid.get(pid);

  it("puts a chat's agent and what it started together, with its folder", () => {
    expect(groupOf(510)).toBe("chat:510");
    expect(groupOf(511)).toBe("chat:510");
    const chat = byId.get("chat:510")!;
    expect(chat.kind).toBe("chat");
    expect(chat.name).toBe("Claude Code");
    expect(chat.cwd).toBe("/home/unowork/project");
    expect(chat.cpuPct).toBe(61);
  });

  it("lets a runaway process of an agent be quit, but not the agent itself", () => {
    expect(result.protectedReason.has(511)).toBe(false);
    expect(result.protectedReason.get(510)).toMatch(/chat/);
  });

  it("recognises a terminal and its programs", () => {
    expect(groupOf(520)).toBe("terminal:520");
    expect(groupOf(521)).toBe("terminal:520");
    expect(byId.get("terminal:520")!.actions).toEqual(["stop"]);
  });

  it("masks secrets in command lines", () => {
    const python = byId.get("terminal:520")!.processes.find((p) => p.pid === 521)!;
    expect(python.command).not.toContain("sk123");
  });

  it("groups a registered app with its wrapper shell", () => {
    expect(groupOf(530)).toBe("app:blog");
    expect(groupOf(531)).toBe("app:blog");
    expect(byId.get("app:blog")!.machineAppId).toBe("manifest:blog");
  });

  it("names containers and keeps their processes out of reach", () => {
    expect(groupOf(601)).toBe("docker:n8n");
    const docker = byId.get("docker:n8n")!;
    expect(docker.detail).toContain("n8nio/n8n");
    expect(docker.actions).toEqual(["stop", "restart"]);
    expect(docker.processes[0]!.canQuit).toBe(false);
  });

  it("finds user services", () => {
    expect(groupOf(700)).toBe("service:user:notes.service");
  });

  it("treats root and kernel processes as the system, and never lets them be quit", () => {
    expect(groupOf(1)).toBe("system");
    expect(groupOf(3)).toBe("system");
    expect(groupOf(801)).toBe("system");
    expect(result.protectedReason.has(801)).toBe(true);
    expect(byId.get("system")!.actions).toEqual([]);
  });

  it("keeps Uno Work itself protected", () => {
    expect(groupOf(SELF)).toBe("unowork");
    expect(result.protectedReason.has(SELF)).toBe(true);
  });

  it("does not lump what the user manager starts under 'systemd'", () => {
    expect(groupOf(800)).toBe("program:htop");
  });

  it("hides other users' command lines", () => {
    const system = byId.get("system")!;
    expect(system.processes.every((p) => p.command === null)).toBe(true);
  });

  it("names unknown containers when docker can't be asked", () => {
    const blind = groupProcesses(input(machine));
    const docker = blind.groups.find((g) => g.kind === "docker")!;
    expect(docker.name).toBe("node");
    expect(docker.detail).toBe(`Docker container ${DOCKER_ID.slice(0, 12)}`);
    expect(docker.actions).toEqual([]);
    expect(docker.actionsBlockedReason).toBeTruthy();
  });
});

describe("on a Mac", () => {
  it("groups by app bundle and protects the Uno Work app above the daemon", () => {
    const electron = proc(300, 1, "Uno Work", {
      exe: "/Applications/Uno Work.app/Contents/MacOS/Uno Work",
    });
    const renderer = proc(301, 300, "Uno Work Helper (Renderer)", {
      exe: "/Applications/Uno Work.app/Contents/Frameworks/Uno Work Helper (Renderer).app/Contents/MacOS/Uno Work Helper (Renderer)",
    });
    const daemon = proc(SELF, 300, "node");
    const chrome = proc(900, 1, "Google Chrome", {
      exe: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    const helper = proc(901, 900, "Google Chrome Helper", {
      exe: "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper",
    });
    const result = groupProcesses(
      input([proc(1, 0, "launchd", { uid: 0 }), electron, renderer, daemon, chrome, helper], {
        platform: "darwin",
      }),
    );
    expect(result.groupOfPid.get(300)).toBe("unowork");
    expect(result.groupOfPid.get(301)).toBe("unowork");
    expect(result.protectedReason.get(301)).toMatch(/Uno Work app/);
    expect(result.groupOfPid.get(901)).toBe("program:Google Chrome");
    const chromeGroup = result.groups.find((g) => g.id === "program:Google Chrome")!;
    expect(chromeGroup.processCount).toBe(2);
    expect(chromeGroup.actions).toEqual(["stop"]);
  });

  it("never offers to quit another copy of the Uno Work app", () => {
    const other = proc(700, 1, "Uno Work", {
      exe: "/Applications/Uno Work.app/Contents/MacOS/Uno Work",
    });
    const daemon = proc(SELF, 1, "node");
    const result = groupProcesses(
      input([proc(1, 0, "launchd", { uid: 0 }), other, daemon], { platform: "darwin" }),
    );
    expect(result.protectedReason.has(700)).toBe(true);
    expect(result.groups.find((g) => g.id === "program:Uno Work")!.actions).toEqual([]);
  });
});
