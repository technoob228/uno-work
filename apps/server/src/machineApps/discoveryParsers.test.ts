import { describe, expect, it } from "vitest";

import {
  extractHtmlTitle,
  groupListeningPorts,
  isUserAddedUnitPath,
  parseCgroupOwner,
  parseDockerPortBindings,
  parseDockerPorts,
  parseDockerPs,
  parseLsofListening,
  parseSsListening,
  parseSystemctlShow,
  parseUnitFileNames,
  splitHostPort,
} from "./discoveryParsers.ts";

describe("splitHostPort", () => {
  it("handles v4, bracketed v6, bare v6, wildcards and zones", () => {
    expect(splitHostPort("0.0.0.0:22")).toEqual({ host: "0.0.0.0", port: 22 });
    expect(splitHostPort("[::]:8080")).toEqual({ host: "::", port: 8080 });
    expect(splitHostPort("[::ffff:127.0.0.1]:3000")).toEqual({
      host: "::ffff:127.0.0.1",
      port: 3000,
    });
    expect(splitHostPort("*:80")).toEqual({ host: "*", port: 80 });
    expect(splitHostPort("127.0.0.53%lo:53")).toEqual({ host: "127.0.0.53", port: 53 });
    expect(splitHostPort("::1:631")).toEqual({ host: "::1", port: 631 });
  });

  it("rejects garbage and out-of-range ports", () => {
    expect(splitHostPort("nonsense")).toBeNull();
    expect(splitHostPort("1.2.3.4:0")).toBeNull();
    expect(splitHostPort("1.2.3.4:70000")).toBeNull();
    expect(splitHostPort("1.2.3.4:*")).toBeNull();
  });
});

const SS_OUTPUT = `State  Recv-Q Send-Q Local Address:Port Peer Address:PortProcess
LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*
LISTEN 0      128          0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=612,fd=3))
LISTEN 0      511        127.0.0.1:5432      0.0.0.0:*
LISTEN 0      511          0.0.0.0:3000      0.0.0.0:*    users:(("node",pid=1234,fd=21))
LISTEN 0      511             [::]:3000         [::]:*    users:(("node",pid=1234,fd=22))
LISTEN 0      4096               *:80              *:*    users:(("uno-work",pid=900,fd=30))
LISTEN 0      4096            [::]:51821        [::]:*
LISTEN 0      511    [::ffff:127.0.0.1]:8787    *:*    users:(("python3",pid=77,fd=5),("python3",pid=78,fd=5))
ESTAB  0      0         10.0.0.2:22     1.2.3.4:5555  users:(("sshd",pid=613,fd=4))
garbage line that should be ignored
`;

describe("parseSsListening", () => {
  it("reads ports, processes and loopback binds, skipping header and non-listeners", () => {
    const sockets = parseSsListening(SS_OUTPUT);
    expect(sockets.map((s) => s.port)).toEqual([53, 22, 5432, 3000, 3000, 80, 51821, 8787]);
    expect(sockets.find((s) => s.port === 22)).toMatchObject({ process: "sshd", pid: 612 });
    expect(sockets.find((s) => s.port === 5432)).toMatchObject({ loopback: true, process: null });
    expect(sockets.find((s) => s.port === 8787)).toMatchObject({
      loopback: true,
      process: "python3",
      pid: 77,
    });
    expect(sockets.find((s) => s.port === 51821)).toMatchObject({ loopback: false, pid: null });
  });

  it("groups v4/v6 twins into one port", () => {
    const ports = groupListeningPorts(parseSsListening(SS_OUTPUT));
    const node = ports.filter((p) => p.port === 3000);
    expect(node).toHaveLength(1);
    expect(node[0]).toMatchObject({ loopbackOnly: false, process: "node", pid: 1234 });
  });

  it("marks a port loopback-only only when every bind is loopback", () => {
    const ports = groupListeningPorts([
      { port: 9000, address: "127.0.0.1", loopback: true, process: null, pid: null },
      { port: 9000, address: "::", loopback: false, process: "app", pid: 5 },
    ]);
    expect(ports[0]?.loopbackOnly).toBe(false);
  });

  it("accepts the Netid-prefixed form", () => {
    expect(parseSsListening("tcp LISTEN 0 5 0.0.0.0:8000 0.0.0.0:*")[0]?.port).toBe(8000);
  });
});

describe("parseLsofListening", () => {
  it("reads -F pcn output", () => {
    const out = [
      "p501",
      "cnode",
      "n*:5173",
      "n[::1]:5173",
      "p777",
      "cpython3.11",
      "n127.0.0.1:8000",
      "n10.0.0.1:1234->10.0.0.2:80",
    ].join("\n");
    const sockets = parseLsofListening(out);
    expect(sockets).toEqual([
      { port: 5173, address: "*", loopback: false, process: "node", pid: 501 },
      { port: 5173, address: "::1", loopback: true, process: "node", pid: 501 },
      { port: 8000, address: "127.0.0.1", loopback: true, process: "python3.11", pid: 777 },
    ]);
  });
});

describe("docker", () => {
  it("parses the Ports column: v4/v6 twins, udp, unpublished, ranges, loopback", () => {
    const ports = parseDockerPorts(
      "0.0.0.0:51820->51820/udp, :::51820->51820/udp, 0.0.0.0:51821->51821/tcp, :::51821->51821/tcp, 8080/tcp, 127.0.0.1:9000-9001->80-81/tcp",
    );
    expect(ports).toEqual([
      { hostPort: 9000, containerPort: 80, protocol: "tcp", loopback: true },
      { hostPort: 9001, containerPort: 81, protocol: "tcp", loopback: true },
      { hostPort: 51820, containerPort: 51820, protocol: "udp", loopback: false },
      { hostPort: 51821, containerPort: 51821, protocol: "tcp", loopback: false },
    ]);
  });

  it("drops malformed and absurd ranges", () => {
    expect(parseDockerPorts("0.0.0.0:1-5000->1-5000/tcp, junk->80/tcp, 0.0.0.0:80->x/tcp")).toEqual(
      [],
    );
  });

  it("parses docker ps JSON lines", () => {
    const out = [
      JSON.stringify({
        ID: "abc123",
        Image: "ghcr.io/wg-easy/wg-easy",
        Names: "wg-easy",
        Ports: "0.0.0.0:51821->51821/tcp, 0.0.0.0:51820->51820/udp",
        State: "running",
        Status: "Up 3 minutes",
        Labels: "com.docker.compose.project=vpn,uno.app.name=My VPN",
      }),
      JSON.stringify({
        ID: "def",
        Image: "nginx",
        Names: "/web",
        Ports: "",
        State: "exited",
        Status: "Exited (0)",
      }),
      "not json",
      JSON.stringify({ ID: "", Names: "nameless" }),
    ].join("\n");
    const containers = parseDockerPs(out);
    expect(containers).toHaveLength(2);
    expect(containers[0]).toMatchObject({
      name: "wg-easy",
      running: true,
      labels: { "com.docker.compose.project": "vpn", "uno.app.name": "My VPN" },
    });
    expect(containers[0]?.ports.map((p) => `${p.hostPort}/${p.protocol}`)).toEqual([
      "51820/udp",
      "51821/tcp",
    ]);
    expect(containers[1]).toMatchObject({ name: "web", running: false, ports: [] });
  });

  it("parses port bindings of stopped containers", () => {
    const out =
      '/web {"80/tcp":[{"HostIp":"","HostPort":"8080"}],"443/tcp":null}\n/broken not-json';
    const bindings = parseDockerPortBindings(out);
    expect(bindings.get("web")).toEqual([
      { hostPort: 8080, containerPort: 80, protocol: "tcp", loopback: false },
    ]);
    expect(bindings.has("broken")).toBe(false);
  });
});

describe("systemd", () => {
  it("parses systemctl show blocks", () => {
    const out = `Id=notes.service
Description=Notes web app
ActiveState=active
SubState=running
FragmentPath=/etc/systemd/system/notes.service
MainPID=4242
UnitFileState=enabled

Id=wg-quick@wg0.service
Description=WireGuard via wg-quick(8) for wg0
ActiveState=active
SubState=exited
FragmentPath=/lib/systemd/system/wg-quick@.service
MainPID=0
UnitFileState=enabled
`;
    const units = parseSystemctlShow(out);
    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({ id: "notes.service", mainPid: 4242, activeState: "active" });
    expect(units[1]).toMatchObject({ id: "wg-quick@wg0.service", mainPid: null });
  });

  it("lists unit names, keeping instances and dropping templates", () => {
    const names = parseUnitFileNames(
      "notes.service enabled enabled\nwg-quick@.service disabled enabled\nwg-quick@wg0.service loaded active exited WireGuard\nsomething.socket enabled\n",
    );
    expect(names).toEqual(["notes.service", "wg-quick@wg0.service"]);
  });

  it("tells user-added unit files from vendor ones", () => {
    expect(isUserAddedUnitPath("/etc/systemd/system/notes.service", "/home/u")).toBe(true);
    expect(isUserAddedUnitPath("/home/u/.config/systemd/user/bot.service", "/home/u")).toBe(true);
    expect(isUserAddedUnitPath("/lib/systemd/system/ssh.service", "/home/u")).toBe(false);
    expect(isUserAddedUnitPath("/usr/lib/systemd/system/nginx.service", "/home/u")).toBe(false);
    expect(isUserAddedUnitPath("", "/home/u")).toBe(false);
  });

  it("finds the owning service or container from a cgroup file", () => {
    expect(parseCgroupOwner("0::/system.slice/notes.service\n")).toEqual({
      kind: "service",
      unit: "notes.service",
    });
    expect(
      parseCgroupOwner("0::/user.slice/user-1000.slice/user@1000.service/app.slice/bot.service"),
    ).toEqual({ kind: "service", unit: "bot.service" });
    expect(parseCgroupOwner(`0::/system.slice/docker-${"a".repeat(64)}.scope`)).toEqual({
      kind: "docker",
      containerId: "a".repeat(64),
    });
    expect(parseCgroupOwner("0::/user.slice/user-1000.slice/session-3.scope")).toBeNull();
  });
});

describe("extractHtmlTitle", () => {
  it("reads and cleans the title", () => {
    expect(extractHtmlTitle("<html><head><title>\n  Notes &amp; more </title>")).toBe(
      "Notes & more",
    );
    expect(extractHtmlTitle("<p>no title</p>")).toBeNull();
    expect(extractHtmlTitle(`<title>${"x".repeat(100)}</title>`)?.length).toBe(60);
  });
});
