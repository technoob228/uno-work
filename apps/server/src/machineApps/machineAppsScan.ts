/**
 * One look at the machine → the programs on its desktop.
 *
 * Sources, strongest first; a port claimed by a stronger source is not shown
 * again by a weaker one:
 *
 *   1. manifests in `~/.uno/apps/*.json` — what a person or an agent declared;
 *   2. docker containers with published ports (running or stopped);
 *   3. systemd services someone added, plus well-known server software
 *      (VPNs, proxies, databases, web servers) even when the OS package
 *      shipped the unit;
 *   4. any other process listening on TCP that answers HTTP or is reachable
 *      from outside the machine.
 *
 * Everything the machine uses to run itself — ssh, DNS, the Uno Work daemon
 * and the AI harnesses it starts — is left out.
 *
 * I/O is injected (`MachineProbe`) so tests replay recorded command output.
 */
import type { UnoMachineApp, UnoMachineAppPublication } from "@t3tools/contracts";

import type { AppManifest } from "./appManifest.ts";
import {
  groupListeningPorts,
  isUserAddedUnitPath,
  parseCgroupOwner,
  parseDockerPortBindings,
  parseDockerPs,
  parseLsofListening,
  parseSsListening,
  parseSystemctlShow,
  parseUnitFileNames,
  type DockerContainer,
  type ListeningPort,
  type SystemdUnit,
} from "./discoveryParsers.ts";

export interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
}

export interface HttpProbe {
  readonly http: boolean;
  readonly title: string | null;
}

export interface MachineProbe {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** The daemon itself and the ports it serves: never shown as programs. */
  readonly selfPid: number;
  readonly selfPorts: ReadonlySet<number>;
  readonly run: (command: string, args: ReadonlyArray<string>) => Promise<CommandResult>;
  readonly readFile: (path: string) => Promise<string | null>;
  readonly probeHttp: (port: number) => Promise<HttpProbe>;
}

/** Processes that are the machine (or Uno Work) running itself. */
const INFRA_PROCESSES = new Set([
  "sshd",
  "systemd",
  "systemd-resolve",
  "systemd-resolved",
  "systemd-network",
  "systemd-networkd",
  "containerd",
  "dockerd",
  "docker-proxy",
  "rpcbind",
  "cupsd",
  "chronyd",
  "avahi-daemon",
  "dnsmasq",
  "exim4",
  "master",
  "uno-box-agent",
  "uno-work",
  "uno-guest-agent",
  "opencode",
  "codex",
  "claude",
  "hermes",
  "cursor-agent",
  // macOS services that listen on TCP (AirPlay, Handoff, sharing).
  "ControlCe",
  "ControlCenter",
  "rapportd",
  "sharingd",
  "AirPlayXPCHelper",
  "remoted",
  "mDNSResponder",
  "identityservicesd",
  "launchd",
]);

/** System ports below 1024 are infrastructure, except the web ones. */
function isSystemPort(port: number): boolean {
  return port < 1024 && port !== 80 && port !== 443;
}

interface KnownSoftware {
  readonly match: RegExp;
  readonly name: string;
  readonly icon: string;
}

/**
 * Server software a person installs on purpose — shown even when its unit
 * file came with the OS package (`wg-quick@wg0`, `nginx`), and used to give
 * containers a recognisable face.
 */
export const KNOWN_SOFTWARE: ReadonlyArray<KnownSoftware> = [
  { match: /wg-easy|wireguard|wg-quick|amnezia/i, name: "WireGuard VPN", icon: "🔐" },
  { match: /openvpn/i, name: "OpenVPN", icon: "🔐" },
  {
    match: /outline|shadowsocks|xray|v2ray|sing-box|3x-ui|marzban|hysteria/i,
    name: "VPN / proxy",
    icon: "🛡️",
  },
  { match: /tailscale/i, name: "Tailscale", icon: "🔗" },
  { match: /3proxy|danted|squid/i, name: "Proxy", icon: "🛡️" },
  { match: /pihole|pi-hole|adguard/i, name: "Ad blocker", icon: "🚫" },
  { match: /nginx/i, name: "nginx", icon: "🌐" },
  { match: /caddy/i, name: "Caddy", icon: "🌐" },
  { match: /apache2|httpd/i, name: "Apache", icon: "🌐" },
  { match: /postgres/i, name: "PostgreSQL", icon: "🐘" },
  { match: /mysql|mariadb/i, name: "MySQL", icon: "🐬" },
  { match: /redis/i, name: "Redis", icon: "🧱" },
  { match: /mongo/i, name: "MongoDB", icon: "🍃" },
  { match: /n8n/i, name: "n8n", icon: "⚙️" },
  { match: /uptime-kuma/i, name: "Uptime Kuma", icon: "📈" },
  { match: /grafana/i, name: "Grafana", icon: "📊" },
  { match: /portainer/i, name: "Portainer", icon: "🐳" },
  { match: /jellyfin|plex/i, name: "Media server", icon: "🎬" },
  { match: /nextcloud/i, name: "Nextcloud", icon: "☁️" },
  { match: /vaultwarden|bitwarden/i, name: "Passwords", icon: "🔑" },
  { match: /gitea|forgejo/i, name: "Git server", icon: "🌿" },
  { match: /code-server/i, name: "VS Code", icon: "🧑‍💻" },
  { match: /syncthing/i, name: "Syncthing", icon: "🔄" },
  { match: /ollama/i, name: "Ollama", icon: "🧠" },
  { match: /open-webui/i, name: "Open WebUI", icon: "💬" },
  { match: /homeassistant|home-assistant/i, name: "Home Assistant", icon: "🏠" },
  { match: /minecraft/i, name: "Minecraft", icon: "⛏️" },
];

export function knownSoftware(text: string): KnownSoftware | null {
  return KNOWN_SOFTWARE.find((k) => k.match.test(text)) ?? null;
}

/** Uno's own units in `/etc/systemd/system` are the machine, not programs. */
function isInfraUnit(unit: string): boolean {
  // fcnet: the guest network setup of every Uno cloud computer.
  return /^(uno-|uno_|snap\.|cloud-|ssh|systemd-|getty|serial-getty|docker\.|containerd|fcnet)/.test(
    unit,
  );
}

export interface ScanInput {
  readonly manifests: ReadonlyArray<AppManifest>;
  /** Icon data URLs by manifest id (read by the caller). */
  readonly manifestIcons: ReadonlyMap<string, string>;
}

export interface ScannedApp extends Omit<UnoMachineApp, "publication"> {
  /** Kept server-side for actions; never trusted from the client. */
  readonly control:
    | { readonly kind: "docker"; readonly container: string }
    | { readonly kind: "systemd"; readonly unit: string; readonly user: boolean }
    | { readonly kind: "process"; readonly pid: number }
    | { readonly kind: "none" };
  readonly manifest: AppManifest | null;
}

export async function readListening(probe: MachineProbe): Promise<ListeningPort[]> {
  if (probe.platform === "linux") {
    const ss = await probe.run("ss", ["-ltnpH"]);
    if (ss.ok) return groupListeningPorts(parseSsListening(ss.stdout));
  }
  const lsof = await probe.run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
  return lsof.ok ? groupListeningPorts(parseLsofListening(lsof.stdout)) : [];
}

export async function readDocker(probe: MachineProbe): Promise<DockerContainer[]> {
  const ps = await probe.run("docker", ["ps", "-a", "--no-trunc", "--format", "{{json .}}"]);
  if (!ps.ok) return [];
  const containers = parseDockerPs(ps.stdout);
  // A stopped container has an empty Ports column; its bindings say what it will publish.
  const stopped = containers.filter((c) => !c.running && c.ports.length === 0).map((c) => c.id);
  if (stopped.length === 0) return containers;
  const inspect = await probe.run("docker", [
    "inspect",
    "--format",
    "{{.Name}} {{json .HostConfig.PortBindings}}",
    ...stopped.slice(0, 50),
  ]);
  if (!inspect.ok) return containers;
  const bindings = parseDockerPortBindings(inspect.stdout);
  return containers.map((c) =>
    !c.running && c.ports.length === 0 ? { ...c, ports: bindings.get(c.name) ?? [] } : c,
  );
}

async function readUnits(probe: MachineProbe, user: boolean): Promise<SystemdUnit[]> {
  const scope = user ? ["--user"] : [];
  const files = await probe.run("systemctl", [
    ...scope,
    "list-unit-files",
    "--type=service",
    "--no-legend",
    "--plain",
    "--no-pager",
  ]);
  if (!files.ok) return [];
  const names = parseUnitFileNames(files.stdout);
  // Instances of template units (wg-quick@wg0) only show up as loaded units.
  const loaded = await probe.run("systemctl", [
    ...scope,
    "list-units",
    "--type=service",
    "--all",
    "--no-legend",
    "--plain",
    "--no-pager",
  ]);
  if (loaded.ok) {
    for (const name of parseUnitFileNames(loaded.stdout)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  const candidates = names.filter((name) => !isInfraUnit(name));
  if (candidates.length === 0) return [];
  const show = await probe.run("systemctl", [
    ...scope,
    "show",
    "--no-pager",
    "-p",
    "Id,Description,ActiveState,SubState,FragmentPath,MainPID,UnitFileState",
    ...candidates.slice(0, 400),
  ]);
  if (!show.ok) return [];
  return parseSystemctlShow(show.stdout).filter((unit) => {
    if (isInfraUnit(unit.id)) return false;
    if (user) return unit.fragmentPath.length > 0;
    if (isUserAddedUnitPath(unit.fragmentPath, probe.home)) return true;
    // A vendor unit counts only for software people install on purpose, and
    // only when it is actually in use.
    return (
      knownSoftware(unit.id) !== null &&
      (unit.activeState === "active" || unit.unitFileState === "enabled")
    );
  });
}

export async function readSystemd(
  probe: MachineProbe,
): Promise<Array<SystemdUnit & { readonly user: boolean }>> {
  if (probe.platform !== "linux") return [];
  const [system, user] = await Promise.all([readUnits(probe, false), readUnits(probe, true)]);
  return [
    ...system.map((u) => ({ ...u, user: false })),
    ...user.map((u) => ({ ...u, user: true })),
  ];
}

/** Which service or container a listening process belongs to (Linux only). */
async function ownerOf(
  probe: MachineProbe,
  pid: number | null,
): Promise<ReturnType<typeof parseCgroupOwner>> {
  if (pid === null || probe.platform !== "linux") return null;
  const content = await probe.readFile(`/proc/${pid}/cgroup`);
  return content ? parseCgroupOwner(content) : null;
}

function prettyName(raw: string): string {
  const base = raw.replace(/\.service$/, "").replace(/@/, " ");
  return base.length > 0 ? base : raw;
}

function localUrlFor(port: number | null, http: boolean, path: string | null): string | null {
  if (port === null || !http) return null;
  return `http://localhost:${port}${path ?? "/"}`;
}

/**
 * Assembles the desktop. `probe.probeHttp` is called once per candidate port,
 * in parallel; the caller caches it.
 */
export async function scanMachineApps(
  probe: MachineProbe,
  input: ScanInput,
): Promise<ScannedApp[]> {
  const [listening, containers, units] = await Promise.all([
    readListening(probe),
    readDocker(probe),
    readSystemd(probe),
  ]);
  const listeningByPort = new Map(listening.map((l) => [l.port, l]));
  const owners = new Map<number, Awaited<ReturnType<typeof ownerOf>>>();
  await Promise.all(
    listening.map(async (l) => {
      owners.set(l.port, await ownerOf(probe, l.pid));
    }),
  );

  // Probe every port that could be a program, once.
  const candidatePorts = new Set<number>();
  for (const m of input.manifests) if (m.port !== null) candidatePorts.add(m.port);
  for (const c of containers)
    for (const p of c.ports) if (p.protocol === "tcp") candidatePorts.add(p.hostPort);
  for (const l of listening) {
    if (!probe.selfPorts.has(l.port) && l.pid !== probe.selfPid && !isSystemPort(l.port)) {
      candidatePorts.add(l.port);
    }
  }
  const httpByPort = new Map<number, HttpProbe>();
  await Promise.all(
    [...candidatePorts].map(async (port) => {
      // Only a port something listens on can answer.
      if (!listeningByPort.has(port)) return;
      httpByPort.set(port, await probe.probeHttp(port));
    }),
  );

  const apps: ScannedApp[] = [];
  const claimed = new Set<number>();

  /* 1. Manifests */
  for (const m of input.manifests) {
    const listener = m.port !== null ? listeningByPort.get(m.port) : undefined;
    const http = m.port !== null ? (httpByPort.get(m.port)?.http ?? false) : false;
    const owner = m.port !== null ? owners.get(m.port) : null;
    const running = m.port !== null ? listener !== undefined : null;
    const control: ScannedApp["control"] =
      owner?.kind === "docker"
        ? { kind: "docker", container: owner.containerId }
        : listener?.pid != null
          ? { kind: "process", pid: listener.pid }
          : { kind: "none" };
    if (m.port !== null) claimed.add(m.port);
    apps.push({
      id: `manifest:${m.id}`,
      source: "manifest",
      name: m.name,
      description: m.description,
      icon: m.icon,
      iconImage: input.manifestIcons.get(m.id) ?? null,
      status: running === null ? "unknown" : running ? "running" : "stopped",
      port: m.port,
      udpPorts: [],
      http: http || (m.port === null && m.url !== null),
      loopbackOnly: listener?.loopbackOnly ?? false,
      detail: m.port !== null ? `Registered · port ${m.port}` : "Registered",
      url: m.url,
      localUrl: localUrlFor(m.port, http, m.path),
      canStart: running === false && m.command !== null,
      canStop: running === true && control.kind !== "none",
      control,
      manifest: m,
    });
  }

  /* 2. Docker */
  for (const c of containers) {
    const tcp = c.ports.filter((p) => p.protocol === "tcp" && !claimed.has(p.hostPort));
    if (tcp.length === 0) {
      // A VPN container may publish only UDP; it is still a program worth showing.
      const udpOnly = c.ports.length > 0 && c.ports.every((p) => p.protocol !== "tcp");
      if (!udpOnly) continue;
    }
    const primary = tcp.find((p) => httpByPort.get(p.hostPort)?.http) ?? tcp[0] ?? null;
    for (const p of tcp) claimed.add(p.hostPort);
    const known = knownSoftware(`${c.image} ${c.name}`);
    const http = primary ? (httpByPort.get(primary.hostPort)?.http ?? false) : false;
    const title = primary ? httpByPort.get(primary.hostPort)?.title : null;
    apps.push({
      id: `docker:${c.name}`,
      source: "docker",
      name: c.labels["uno.app.name"]?.slice(0, 60) || c.name,
      description: known && known.name !== c.name ? known.name : (title ?? null),
      icon: known?.icon ?? "🐳",
      iconImage: null,
      status: c.running ? "running" : "stopped",
      port: primary?.hostPort ?? null,
      udpPorts: c.ports.filter((p) => p.protocol === "udp" && !p.loopback).map((p) => p.hostPort),
      http,
      loopbackOnly: primary?.loopback ?? false,
      detail: `Docker · ${c.image.replace(/@sha256:.*$/, "").slice(0, 60)}`,
      url: null,
      localUrl: c.running ? localUrlFor(primary?.hostPort ?? null, http, null) : null,
      canStart: !c.running,
      canStop: c.running,
      control: { kind: "docker", container: c.name },
      manifest: null,
    });
  }

  /* 3. systemd */
  for (const unit of units) {
    const ports = listening.filter((l) => {
      const owner = owners.get(l.port);
      return owner?.kind === "service" && owner.unit === unit.id && !claimed.has(l.port);
    });
    const primary = ports.find((l) => httpByPort.get(l.port)?.http) ?? ports[0] ?? null;
    for (const l of ports) claimed.add(l.port);
    const running = unit.activeState === "active" || unit.activeState === "activating";
    const known = knownSoftware(unit.id);
    const http = primary ? (httpByPort.get(primary.port)?.http ?? false) : false;
    const describe = unit.description && unit.description !== unit.id ? unit.description : null;
    apps.push({
      id: `systemd:${unit.user ? "user:" : ""}${unit.id}`,
      source: "systemd",
      name:
        known && !unit.user && !isUserAddedUnitPath(unit.fragmentPath, probe.home)
          ? known.name
          : prettyName(unit.id),
      description: describe?.slice(0, 200) ?? null,
      icon: known?.icon ?? "⚙️",
      iconImage: null,
      status: running ? "running" : "stopped",
      port: primary?.port ?? null,
      udpPorts: [],
      http,
      loopbackOnly: primary?.loopbackOnly ?? false,
      detail: `Service · ${unit.id}${unit.user ? "" : " · system"}`,
      url: null,
      localUrl: running ? localUrlFor(primary?.port ?? null, http, null) : null,
      // System units need root, and the daemon deliberately has none.
      canStart: unit.user && !running,
      canStop: unit.user && running,
      control: { kind: "systemd", unit: unit.id, user: unit.user },
      manifest: null,
    });
  }

  /* 4. Anything else that listens */
  for (const l of listening) {
    if (claimed.has(l.port)) continue;
    if (probe.selfPorts.has(l.port) || (l.pid !== null && l.pid === probe.selfPid)) continue;
    if (isSystemPort(l.port)) continue;
    if (l.process !== null && INFRA_PROCESSES.has(l.process)) continue;
    const owner = owners.get(l.port);
    if (owner?.kind === "docker") continue; // docker-proxy for a container shown above
    if (owner?.kind === "service" && isInfraUnit(owner.unit)) continue;
    const probeResult = httpByPort.get(l.port);
    const http = probeResult?.http ?? false;
    // Loopback-only and not a web page: a database or an internal socket, not a program.
    if (!http && l.loopbackOnly) continue;
    // On a Mac every chat app listens on something; only web pages count there.
    if (!http && probe.platform === "darwin") continue;
    const known = knownSoftware(l.process ?? "");
    apps.push({
      id: `port:${l.port}`,
      source: "port",
      name: probeResult?.title ?? known?.name ?? (l.process ? `${l.process}` : `Port ${l.port}`),
      description: null,
      icon: known?.icon ?? null,
      iconImage: null,
      status: "running",
      port: l.port,
      udpPorts: [],
      http,
      loopbackOnly: l.loopbackOnly,
      detail: l.process ? `${l.process} · port ${l.port}` : `Port ${l.port}`,
      url: null,
      localUrl: localUrlFor(l.port, http, null),
      canStart: false,
      canStop: l.pid !== null,
      control: l.pid !== null ? { kind: "process", pid: l.pid } : { kind: "none" },
      manifest: null,
    });
  }

  return apps;
}

export interface PortForward {
  readonly id: number;
  readonly internalPort: number;
  readonly externalPort: number | null;
  readonly protocol: string;
  readonly visibility: string;
  readonly state: string;
}

/** Ports that are never an app's to show or hide: SSH and the computer's own address. */
export const RESERVED_FORWARD_PORTS: ReadonlySet<number> = new Set([22, 80]);

export function parsePortForwards(raw: unknown): PortForward[] {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(raw) ? raw : Array.isArray(record["ports"]) ? record["ports"] : [];
  const out: PortForward[] = [];
  for (const item of list as unknown[]) {
    const r = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
    if (!r) continue;
    const id = typeof r["id"] === "number" ? r["id"] : null;
    const internal =
      typeof r["internal_port"] === "number"
        ? r["internal_port"]
        : typeof r["port"] === "number"
          ? r["port"]
          : null;
    if (id === null || internal === null) continue;
    out.push({
      id,
      internalPort: internal,
      externalPort: typeof r["external_port"] === "number" ? r["external_port"] : null,
      protocol: typeof r["protocol"] === "string" ? r["protocol"] : "tcp",
      visibility: typeof r["visibility"] === "string" ? r["visibility"] : "public",
      state: typeof r["state"] === "string" ? r["state"] : "applied",
    });
  }
  return out;
}

/**
 * The public forwards of an app's ports, and the address they give. The
 * control plane builds `http://<computer's name>:<external port>` for a
 * hand-published port (the `https://<app>-<computer>` names are for App Store
 * installs). UDP ports (a VPN tunnel) count too: they have no web address, but
 * "Hide" must take them down with the rest.
 */
export function publicationFor(
  app: { readonly port: number | null; readonly udpPorts: ReadonlyArray<number> },
  forwards: ReadonlyArray<PortForward>,
  hostname: string | null,
): UnoMachineAppPublication | null {
  const live = (f: PortForward) =>
    f.visibility === "public" && f.state !== "deleting" && f.state !== "failed";
  const main =
    app.port !== null && !RESERVED_FORWARD_PORTS.has(app.port)
      ? forwards.find((f) => f.internalPort === app.port && f.protocol === "tcp" && live(f))
      : undefined;
  const udp = forwards.filter(
    (f) =>
      f.protocol === "udp" &&
      app.udpPorts.includes(f.internalPort) &&
      !RESERVED_FORWARD_PORTS.has(f.internalPort) &&
      live(f),
  );
  if (!main && udp.length === 0) return null;
  const host = hostname?.replace(/^https?:\/\//, "").replace(/\/.*$/, "") ?? null;
  const all = [...(main ? [main] : []), ...udp];
  return {
    forwardId: main?.id ?? null,
    externalPort: main?.externalPort ?? null,
    url:
      main && host && main.externalPort !== null && main.state !== "pending"
        ? `http://${host}:${main.externalPort}/`
        : null,
    host,
    state: all.some((f) => f.state === "pending") ? "pending" : (all[0]?.state ?? "applied"),
    forwards: all.map((f) => ({
      forwardId: f.id,
      internalPort: f.internalPort,
      externalPort: f.externalPort,
      protocol: f.protocol,
    })),
  };
}
