/**
 * Parsers for what the machine says about itself: listening sockets (`ss` on
 * Linux, `lsof` on macOS), docker containers, systemd units and process
 * cgroups. Pure functions over command output, so the tests drive them with
 * recorded text and a malformed line is skipped instead of breaking the scan.
 */

export interface ListeningSocket {
  readonly port: number;
  /** Bind address as printed: `0.0.0.0`, `::`, `127.0.0.1`, `*`, … */
  readonly address: string;
  readonly loopback: boolean;
  readonly process: string | null;
  readonly pid: number | null;
}

/** One port, possibly bound on several addresses (v4 + v6). */
export interface ListeningPort {
  readonly port: number;
  /** True only when every bind of this port is on loopback. */
  readonly loopbackOnly: boolean;
  readonly process: string | null;
  readonly pid: number | null;
}

const MAX_PORT = 65_535;

function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= MAX_PORT ? port : null;
}

/** Splits `host:port` where host may be `[v6]`, `v6`, `*` or carry a `%iface` zone. */
export function splitHostPort(raw: string): { host: string; port: number } | null {
  const index = raw.lastIndexOf(":");
  if (index <= 0 && raw[0] !== "*") return null;
  const port = parsePort(raw.slice(index + 1));
  if (port === null) return null;
  let host = raw.slice(0, index);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  return { host: host || "*", port };
}

export function isLoopbackAddress(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    h.startsWith("127.") ||
    h.startsWith("::ffff:127.")
  );
}

/**
 * `ss -ltnpH` (or without `-H`):
 *
 *   LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=612,fd=3))
 *   LISTEN 0 511  [::ffff:127.0.0.1]:3000 *:* users:(("node",pid=1234,fd=21))
 *
 * Without root, sockets of other users have no `users:` column — the port is
 * still there, only the process is unknown.
 */
export function parseSsListening(output: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || /^(State|Netid)\b/.test(trimmed)) continue;
    const columns = trimmed.split(/\s+/);
    // With `-t` the first column is the state; with `-A`/no `-t` a Netid comes first.
    const offset = columns[0] === "tcp" ? 1 : 0;
    if (columns[offset] !== "LISTEN") continue;
    const local = columns[offset + 3];
    if (!local) continue;
    const hostPort = splitHostPort(local);
    if (!hostPort) continue;
    const rest = columns.slice(offset + 5).join(" ");
    const users = /users:\(\("((?:[^"\\]|\\.)*)",pid=(\d+)/.exec(rest);
    sockets.push({
      port: hostPort.port,
      address: hostPort.host,
      loopback: isLoopbackAddress(hostPort.host),
      process: users?.[1] ?? null,
      pid: users?.[2] ? Number(users[2]) : null,
    });
  }
  return sockets;
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -F pcn` (macOS and Linux without ss): one
 * field per line — `p<pid>`, `c<command>`, `n<addr:port>`; a `p` starts a
 * new process, every `n` after it is one socket of that process.
 */
export function parseLsofListening(output: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  let pid: number | null = null;
  let command: string | null = null;
  for (const line of output.split("\n")) {
    if (line.length < 2) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      pid = /^\d+$/.test(value) ? Number(value) : null;
      command = null;
    } else if (field === "c") {
      command = value;
    } else if (field === "n") {
      // Established sockets print `a->b`; only bare listeners interest us.
      if (value.includes("->")) continue;
      const hostPort = splitHostPort(value);
      if (!hostPort) continue;
      sockets.push({
        port: hostPort.port,
        address: hostPort.host,
        loopback: isLoopbackAddress(hostPort.host),
        process: command,
        pid,
      });
    }
  }
  return sockets;
}

/** Collapses v4/v6 duplicates into one entry per port, sorted by port. */
export function groupListeningPorts(sockets: ReadonlyArray<ListeningSocket>): ListeningPort[] {
  const byPort = new Map<number, ListeningSocket[]>();
  for (const socket of sockets) {
    const list = byPort.get(socket.port) ?? [];
    list.push(socket);
    byPort.set(socket.port, list);
  }
  return [...byPort.entries()]
    .map(([port, list]) => {
      const named = list.find((s) => s.process !== null) ?? list[0]!;
      return {
        port,
        loopbackOnly: list.every((s) => s.loopback),
        process: named.process,
        pid: named.pid,
      };
    })
    .toSorted((a, b) => a.port - b.port);
}

/* ------------------------------------------------------------------ *
 * docker
 * ------------------------------------------------------------------ */

export interface DockerPublishedPort {
  readonly hostPort: number;
  readonly containerPort: number;
  readonly protocol: string;
  readonly loopback: boolean;
}

export interface DockerContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly running: boolean;
  readonly status: string;
  readonly ports: ReadonlyArray<DockerPublishedPort>;
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * The `Ports` column of `docker ps`:
 *   `0.0.0.0:51821->51821/tcp, :::51821->51821/tcp, 51820/udp, 127.0.0.1:8000-8001->80-81/tcp`
 * Unpublished ports (no `->`) are dropped; ranges expand; v4/v6 twins merge.
 */
export function parseDockerPorts(raw: string): DockerPublishedPort[] {
  const out = new Map<string, DockerPublishedPort>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    const arrow = entry.indexOf("->");
    if (arrow === -1) continue;
    const hostSide = splitHostRange(entry.slice(0, arrow));
    const containerSide = /^(\d{1,5})(?:-(\d{1,5}))?\/(\w+)$/.exec(entry.slice(arrow + 2));
    if (!hostSide || !containerSide) continue;
    const cStart = Number(containerSide[1]);
    const cEnd = containerSide[2] ? Number(containerSide[2]) : cStart;
    const protocol = containerSide[3]!.toLowerCase();
    const span = hostSide.end - hostSide.start;
    if (span < 0 || span > 100 || cEnd - cStart !== span) continue;
    for (let i = 0; i <= span; i++) {
      const hostPort = hostSide.start + i;
      if (hostPort < 1 || hostPort > MAX_PORT) continue;
      const key = `${hostPort}/${protocol}`;
      const previous = out.get(key);
      out.set(key, {
        hostPort,
        containerPort: cStart + i,
        protocol,
        loopback: (previous?.loopback ?? true) && hostSide.loopback,
      });
    }
  }
  return [...out.values()].toSorted((a, b) => a.hostPort - b.hostPort);
}

function splitHostRange(raw: string): { start: number; end: number; loopback: boolean } | null {
  const index = raw.lastIndexOf(":");
  if (index === -1) return null;
  const range = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(raw.slice(index + 1));
  if (!range) return null;
  let host = raw.slice(0, index);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return {
    start: Number(range[1]),
    end: range[2] ? Number(range[2]) : Number(range[1]),
    loopback: isLoopbackAddress(host),
  };
}

function parseDockerLabels(raw: unknown): Record<string, string> {
  const labels: Record<string, string> = {};
  if (typeof raw !== "string" || raw.length === 0) return labels;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    labels[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return labels;
}

/** `docker ps -a --no-trunc --format '{{json .}}'` — one JSON object per line. */
export function parseDockerPs(output: string): DockerContainer[] {
  const containers: DockerContainer[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = typeof record["ID"] === "string" ? record["ID"] : "";
    const names = typeof record["Names"] === "string" ? record["Names"] : "";
    const name = names.split(",")[0]?.replace(/^\//, "").trim() ?? "";
    if (id.length === 0 || name.length === 0) continue;
    const state = typeof record["State"] === "string" ? record["State"].toLowerCase() : "";
    const status = typeof record["Status"] === "string" ? record["Status"] : "";
    containers.push({
      id,
      name,
      image: typeof record["Image"] === "string" ? record["Image"] : "",
      running: state === "running" || (state === "" && /^Up\b/.test(status)),
      status,
      ports: parseDockerPorts(typeof record["Ports"] === "string" ? record["Ports"] : ""),
      labels: parseDockerLabels(record["Labels"]),
    });
  }
  return containers;
}

/**
 * `docker inspect --format '{{.Name}} {{json .HostConfig.PortBindings}}' …` —
 * the ports a *stopped* container will publish when started (its `Ports`
 * column is empty while it is down).
 */
export function parseDockerPortBindings(output: string): Map<string, DockerPublishedPort[]> {
  const out = new Map<string, DockerPublishedPort[]>();
  for (const line of output.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const name = line.slice(0, space).replace(/^\//, "").trim();
    let bindings: unknown;
    try {
      bindings = JSON.parse(line.slice(space + 1));
    } catch {
      continue;
    }
    if (typeof bindings !== "object" || bindings === null) continue;
    const ports: DockerPublishedPort[] = [];
    for (const [key, value] of Object.entries(bindings as Record<string, unknown>)) {
      const m = /^(\d{1,5})\/(\w+)$/.exec(key);
      if (!m || !Array.isArray(value)) continue;
      for (const binding of value) {
        const record = binding as Record<string, unknown> | null;
        const hostPort = parsePort(String(record?.["HostPort"] ?? ""));
        if (hostPort === null) continue;
        ports.push({
          hostPort,
          containerPort: Number(m[1]),
          protocol: m[2]!.toLowerCase(),
          loopback: isLoopbackAddress(String(record?.["HostIp"] ?? "")),
        });
      }
    }
    out.set(name, ports);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * systemd
 * ------------------------------------------------------------------ */

export interface SystemdUnit {
  readonly id: string;
  readonly description: string;
  readonly activeState: string;
  readonly subState: string;
  readonly fragmentPath: string;
  readonly mainPid: number | null;
  readonly unitFileState: string;
}

/**
 * `systemctl show -p Id,Description,ActiveState,SubState,FragmentPath,MainPID,UnitFileState <units…>`:
 * `key=value` lines, units separated by a blank line.
 */
export function parseSystemctlShow(output: string): SystemdUnit[] {
  const units: SystemdUnit[] = [];
  const flush = (fields: Map<string, string>) => {
    const id = fields.get("Id") ?? "";
    if (id.length === 0) return;
    const pid = Number(fields.get("MainPID") ?? "0");
    units.push({
      id,
      description: fields.get("Description") ?? "",
      activeState: fields.get("ActiveState") ?? "",
      subState: fields.get("SubState") ?? "",
      fragmentPath: fields.get("FragmentPath") ?? "",
      mainPid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      unitFileState: fields.get("UnitFileState") ?? "",
    });
  };
  let fields = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) {
      flush(fields);
      fields = new Map();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
  }
  flush(fields);
  return units;
}

/** `systemctl list-unit-files --type=service --no-legend --plain` → unit names. */
export function parseUnitFileNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const name = line.trim().split(/\s+/)[0] ?? "";
    // Templates (`foo@.service`) are not something that runs.
    if (/^[\w.:@-]+\.service$/.test(name) && !name.endsWith("@.service")) names.push(name);
  }
  return names;
}

/**
 * Units a person or an agent added, as opposed to the ones the OS ships:
 * the unit file lives in the admin or user config tree, not in a vendor dir.
 */
export function isUserAddedUnitPath(fragmentPath: string, home: string): boolean {
  if (fragmentPath.length === 0) return false;
  if (fragmentPath.startsWith("/etc/systemd/system/")) return true;
  const userDir = `${home.replace(/\/$/, "")}/.config/systemd/user/`;
  return fragmentPath.startsWith(userDir);
}

/**
 * The service a process belongs to, from `/proc/<pid>/cgroup`:
 *   `0::/system.slice/notes.service`
 *   `0::/user.slice/user-1000.slice/user@1000.service/app.slice/notes.service`
 *   `0::/system.slice/docker-<64 hex>.scope`
 */
export function parseCgroupOwner(
  content: string,
): { kind: "service"; unit: string } | { kind: "docker"; containerId: string } | null {
  let result: ReturnType<typeof parseCgroupOwner> = null;
  for (const line of content.split("\n")) {
    const path = line.split(":").slice(2).join(":");
    if (path.length === 0) continue;
    const docker = /docker-([0-9a-f]{12,64})\.scope/.exec(path) ?? /\/docker\/([0-9a-f]{12,64})/.exec(path);
    if (docker) return { kind: "docker", containerId: docker[1]! };
    const segments = path.split("/").filter(Boolean);
    const service = segments.toReversed().find((s) => s.endsWith(".service") && !s.startsWith("user@"));
    if (service && result === null) result = { kind: "service", unit: service };
  }
  return result;
}

/** `<title>` of an HTML page, trimmed and de-entitied for the basics. */
export function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i.exec(html);
  if (!m) return null;
  const text = m[1]!
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text.slice(0, 60) : null;
}
