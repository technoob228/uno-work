import { describe, expect, it } from "vitest";

import type { AppManifest } from "./appManifest.ts";
import {
  isUnoContainer,
  parsePortForwards,
  publicationFor,
  scanMachineApps,
  type MachineProbe,
} from "./machineAppsScan.ts";

const SS = `LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=612,fd=3))
LISTEN 0 4096 *:80 *:* users:(("uno-work",pid=900,fd=30))
LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=21))
LISTEN 0 4096 0.0.0.0:51821 0.0.0.0:*
LISTEN 0 511 0.0.0.0:8080 0.0.0.0:* users:(("python3",pid=4242,fd=5))
LISTEN 0 511 127.0.0.1:5432 0.0.0.0:*
LISTEN 0 511 127.0.0.1:4096 0.0.0.0:* users:(("opencode",pid=950,fd=5))
LISTEN 0 511 0.0.0.0:9999 0.0.0.0:* users:(("game",pid=31,fd=5))
LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=77,fd=5))
`;

const DOCKER = [
  JSON.stringify({
    ID: "c1",
    Image: "ghcr.io/wg-easy/wg-easy:latest",
    Names: "wg-easy",
    Ports: "0.0.0.0:51820->51820/udp, 0.0.0.0:51821->51821/tcp",
    State: "running",
    Status: "Up",
  }),
  JSON.stringify({ ID: "c2", Image: "busybox", Names: "no-ports", Ports: "", State: "running" }),
].join("\n");

const UNIT_FILES =
  "notes-api.service enabled enabled\nssh.service enabled enabled\nuno-work.service enabled enabled\n";
const SHOW = `Id=notes-api.service
Description=Notes API
ActiveState=active
SubState=running
FragmentPath=/etc/systemd/system/notes-api.service
MainPID=4242
UnitFileState=enabled

Id=ssh.service
Description=OpenBSD Secure Shell server
ActiveState=active
SubState=running
FragmentPath=/lib/systemd/system/ssh.service
MainPID=612
UnitFileState=enabled
`;

function fakeProbe(overrides: Partial<MachineProbe> = {}): MachineProbe {
  return {
    platform: "linux",
    home: "/home/unowork",
    selfPid: 900,
    selfPorts: new Set([80]),
    run: async (command, args) => {
      if (command === "ss") return { ok: true, stdout: SS };
      if (command === "docker" && args[0] === "ps") return { ok: true, stdout: DOCKER };
      if (command === "systemctl" && args[0] === "--user") return { ok: false, stdout: "" };
      if (command === "systemctl" && args[0] === "list-unit-files")
        return { ok: true, stdout: UNIT_FILES };
      if (command === "systemctl" && args[0] === "list-units") return { ok: true, stdout: "" };
      if (command === "systemctl" && args[0] === "show") return { ok: true, stdout: SHOW };
      return { ok: false, stdout: "" };
    },
    readFile: async (file) =>
      file === "/proc/4242/cgroup" ? "0::/system.slice/notes-api.service\n" : null,
    probeHttp: async (port) =>
      port === 3000
        ? { http: true, title: "My Notes" }
        : port === 51821 || port === 8080 || port === 5173
          ? { http: true, title: null }
          : { http: false, title: null },
    ...overrides,
  };
}

const MANIFEST: AppManifest = {
  id: "notes",
  name: "Notes",
  description: "Notes app",
  icon: "📝",
  iconFile: null,
  port: 3000,
  path: "/app",
  url: null,
  command: "node server.js",
  cwd: null,
  autostart: true,
  ai: null,
};

describe("scanMachineApps", () => {
  it("finds every kind of program and leaves the machine's own plumbing out", async () => {
    const apps = await scanMachineApps(fakeProbe(), {
      manifests: [MANIFEST],
      manifestIcons: new Map(),
    });
    const ids = apps.map((a) => a.id);
    expect(ids).toEqual([
      "manifest:notes",
      "docker:wg-easy",
      "systemd:notes-api.service",
      "port:5173",
      "port:9999",
    ]);
    // ssh (22), the daemon itself (80), opencode, and a loopback-only database are not programs.
    expect(ids.join()).not.toMatch(/:22\b|:80\b|4096|5432|ssh|uno-work/);
  });

  it("describes a registered app with its manifest, status and local address", async () => {
    const [notes] = await scanMachineApps(fakeProbe(), {
      manifests: [MANIFEST],
      manifestIcons: new Map([["notes", "data:image/png;base64,AA=="]]),
    });
    expect(notes).toMatchObject({
      source: "manifest",
      name: "Notes",
      icon: "📝",
      iconImage: "data:image/png;base64,AA==",
      status: "running",
      port: 3000,
      http: true,
      localUrl: "http://localhost:3000/app",
      canStart: false,
      canStop: true,
      control: { kind: "process", pid: 1234 },
    });
  });

  it("offers Start for a registered app whose port is silent", async () => {
    const [notes] = await scanMachineApps(fakeProbe(), {
      manifests: [{ ...MANIFEST, port: 3100 }],
      manifestIcons: new Map(),
    });
    expect(notes).toMatchObject({ status: "stopped", canStart: true, canStop: false });
  });

  it("recognises a VPN container and its web UI port", async () => {
    const apps = await scanMachineApps(fakeProbe(), { manifests: [], manifestIcons: new Map() });
    expect(apps.find((a) => a.id === "docker:wg-easy")).toMatchObject({
      name: "wg-easy",
      description: "WireGuard VPN",
      icon: "🔐",
      port: 51821,
      udpPorts: [51820],
      http: true,
      status: "running",
      canStop: true,
      control: { kind: "docker", container: "wg-easy" },
    });
  });

  it("ties a listening port to its systemd service through the cgroup", async () => {
    const apps = await scanMachineApps(fakeProbe(), { manifests: [], manifestIcons: new Map() });
    const unit = apps.find((a) => a.id === "systemd:notes-api.service");
    expect(unit).toMatchObject({ port: 8080, status: "running", canStop: false });
    expect(apps.some((a) => a.id === "port:8080")).toBe(false);
  });

  it("shows a vendor unit only for software people install on purpose", async () => {
    const probe = fakeProbe({
      run: async (command, args) => {
        if (command === "systemctl" && args[0] === "list-unit-files")
          return {
            ok: true,
            stdout:
              "wg-quick@.service disabled enabled\nnginx.service enabled enabled\ncron.service enabled enabled\n",
          };
        if (command === "systemctl" && args[0] === "list-units")
          return { ok: true, stdout: "wg-quick@wg0.service loaded active exited WireGuard\n" };
        if (command === "systemctl" && args[0] === "show")
          return {
            ok: true,
            stdout: [
              "Id=nginx.service\nActiveState=active\nFragmentPath=/lib/systemd/system/nginx.service\nUnitFileState=enabled\n",
              "Id=cron.service\nActiveState=active\nFragmentPath=/lib/systemd/system/cron.service\nUnitFileState=enabled\n",
              "Id=wg-quick@wg0.service\nActiveState=active\nFragmentPath=/lib/systemd/system/wg-quick@.service\nUnitFileState=enabled\n",
            ].join("\n"),
          };
        return { ok: false, stdout: "" };
      },
    });
    const apps = await scanMachineApps(probe, { manifests: [], manifestIcons: new Map() });
    expect(apps.map((a) => a.id)).toEqual([
      "systemd:nginx.service",
      "systemd:wg-quick@wg0.service",
    ]);
    expect(apps[1]).toMatchObject({ name: "WireGuard VPN", icon: "🔐" });
  });

  it("on a Mac shows only listeners that answer HTTP", async () => {
    const probe = fakeProbe({
      platform: "darwin",
      run: async (command) =>
        command === "lsof"
          ? { ok: true, stdout: "p10\ncnode\nn*:5173\np11\ncSpotify\nn*:57621\n" }
          : { ok: false, stdout: "" },
      probeHttp: async (port) => ({
        http: port === 5173,
        title: port === 5173 ? "Vite App" : null,
      }),
    });
    const apps = await scanMachineApps(probe, { manifests: [], manifestIcons: new Map() });
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      id: "port:5173",
      name: "Vite App",
      localUrl: "http://localhost:5173/",
    });
  });

  it("survives a machine with none of the tools", async () => {
    const probe = fakeProbe({ run: async () => ({ ok: false, stdout: "" }) });
    expect(await scanMachineApps(probe, { manifests: [], manifestIcons: new Map() })).toEqual([]);
  });
});

describe("publication", () => {
  const forwards = parsePortForwards({
    ports: [
      {
        id: 1,
        internal_port: 22,
        external_port: 40122,
        protocol: "tcp",
        visibility: "public",
        state: "applied",
      },
      {
        id: 2,
        internal_port: 80,
        external_port: 40180,
        protocol: "tcp",
        visibility: "public",
        state: "applied",
      },
      {
        id: 3,
        internal_port: 3000,
        external_port: 43000,
        protocol: "tcp",
        visibility: "public",
        state: "applied",
      },
      {
        id: 4,
        internal_port: 4000,
        external_port: 44000,
        protocol: "tcp",
        visibility: "private",
        state: "applied",
      },
      { id: 5, internal_port: 5000, external_port: 45000, protocol: "tcp", state: "pending" },
      {
        id: 6,
        internal_port: 51820,
        external_port: 45820,
        protocol: "udp",
        visibility: "public",
        state: "applied",
      },
      { internal_port: 6000 },
    ],
  });
  const tcp = (port: number | null) => ({ port, udpPorts: [] as number[] });

  it("parses the ports list", () => {
    expect(forwards.map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("gives the address of a public forward", () => {
    expect(publicationFor(tcp(3000), forwards, "my-computer.u85.uno4.me")).toEqual({
      forwardId: 3,
      externalPort: 43000,
      url: "http://my-computer.u85.uno4.me:43000/",
      host: "my-computer.u85.uno4.me",
      state: "applied",
      forwards: [{ forwardId: 3, internalPort: 3000, externalPort: 43000, protocol: "tcp" }],
    });
  });

  it("never treats SSH or the computer's own address as an app's publication", () => {
    expect(publicationFor(tcp(22), forwards, "h")).toBeNull();
    expect(publicationFor(tcp(80), forwards, "h")).toBeNull();
    expect(publicationFor({ port: null, udpPorts: [22] }, forwards, "h")).toBeNull();
  });

  it("ignores private forwards and holds the address back while pending", () => {
    expect(publicationFor(tcp(4000), forwards, "h")).toBeNull();
    expect(publicationFor(tcp(5000), forwards, "h")).toMatchObject({
      forwardId: 5,
      url: null,
      state: "pending",
    });
    expect(publicationFor(tcp(null), forwards, "h")).toBeNull();
  });

  it("counts a VPN's UDP tunnel next to its web panel", () => {
    const vpn = publicationFor({ port: 3000, udpPorts: [51820] }, forwards, "h");
    expect(vpn?.forwards.map((f) => `${f.internalPort}/${f.protocol}`)).toEqual([
      "3000/tcp",
      "51820/udp",
    ]);
    const tunnelOnly = publicationFor({ port: null, udpPorts: [51820] }, forwards, "h");
    expect(tunnelOnly).toMatchObject({ forwardId: null, url: null, host: "h" });
    expect(tunnelOnly?.forwards).toHaveLength(1);
  });
});

describe("docker containers and Remove (0.0.72)", () => {
  const containers = [
    {
      ID: "u1",
      Image: "ghcr.io/me/my-bot",
      Names: "my-bot",
      Ports: "0.0.0.0:7000->7000/tcp",
      State: "running",
      Labels: "com.docker.compose.project=bots,com.docker.compose.service=bot",
    },
    {
      ID: "s1",
      Image: "neosmemo/memos",
      Names: "uno-memos-memos-1",
      Ports: "0.0.0.0:5230->5230/tcp",
      State: "running",
      Labels: "com.docker.compose.project=uno-memos",
    },
    {
      ID: "s2",
      Image: "collabora/code",
      Names: "office",
      Ports: "127.0.0.1:9980->9980/tcp",
      State: "running",
      Labels: "uno.system=office",
    },
  ];
  const probe = fakeProbe({
    run: async (command, args) => {
      if (command === "docker" && args[0] === "ps") {
        return { ok: true, stdout: containers.map((c) => JSON.stringify(c)).join("\n") };
      }
      return { ok: false, stdout: "" };
    },
  });

  it("reads the compose project and offers Remove only for the person's own containers", async () => {
    const apps = await scanMachineApps(probe, { manifests: [], manifestIcons: new Map() });
    const byId = Object.fromEntries(apps.map((a) => [a.id, a]));
    expect(byId["docker:my-bot"]).toMatchObject({ canRemove: true, composeProject: "bots" });
    expect(byId["docker:uno-memos-memos-1"]).toMatchObject({
      canRemove: false,
      composeProject: "uno-memos",
    });
    expect(byId["docker:office"]).toMatchObject({ canRemove: false, composeProject: null });
  });

  it("never offers Remove for anything but a container", async () => {
    const apps = await scanMachineApps(fakeProbe(), {
      manifests: [MANIFEST],
      manifestIcons: new Map(),
    });
    for (const app of apps) {
      expect(app.canRemove, app.id).toBe(app.source === "docker");
    }
  });
});

describe("isUnoContainer", () => {
  it("knows Uno's own and App Store containers", () => {
    expect(isUnoContainer({ name: "uno-office", labels: {} })).toBe(true);
    expect(
      isUnoContainer({ name: "memos-1", labels: { "com.docker.compose.project": "uno-memos" } }),
    ).toBe(true);
    expect(isUnoContainer({ name: "x", labels: { "uno.managed": "1" } })).toBe(true);
    expect(isUnoContainer({ name: "my-bot", labels: { "uno.app.name": "My bot" } })).toBe(false);
    expect(isUnoContainer({ name: "unobtainium", labels: {} })).toBe(false);
  });
});
