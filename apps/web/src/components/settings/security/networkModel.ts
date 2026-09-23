/**
 * "Who can reach it" — the plain logic behind NetworkAccess.tsx: the API
 * shapes (GET/PUT /api/v1/boxes/{id}/security/network), the words for each
 * choice, which ports the person can pick, what is reachable right now, and
 * checking typed addresses. No React here, so it is unit-tested.
 */

export type Internet = "open" | "closed";
export type OpenMode = "all" | "ports" | "allowlist" | "vpn";
export type PortAccess = "public" | "allowlist" | "private";
export type PortKind = "uno_work" | "ssh" | "app" | "vpn" | "other";

export interface NetworkPolicy {
  readonly internet: Internet;
  readonly open_mode: OpenMode;
  readonly open_ports: ReadonlyArray<number>;
  readonly allowed_ips: ReadonlyArray<string>;
  readonly ssh_enabled: boolean;
  readonly updated_at?: string;
}

export interface NetworkPort {
  readonly id: number;
  readonly internal_port: number;
  readonly protocol: "tcp" | "udp";
  readonly external_port: number;
  readonly address: string;
  readonly kind: PortKind;
  readonly app_name?: string;
  readonly app_url?: string;
  readonly configured: PortAccess;
  readonly effective: PortAccess;
}

export interface NetworkSecurity {
  readonly policy: NetworkPolicy;
  readonly is_work_machine: boolean;
  readonly ports: ReadonlyArray<NetworkPort>;
  readonly vpn: { readonly installed: boolean; readonly app_id: string; readonly app_url?: string };
  readonly your_ip?: string;
}

/** The PUT body: always the whole policy, so nothing is left to server defaults. */
export type NetworkPolicyBody = Pick<
  NetworkPolicy,
  "internet" | "open_mode" | "open_ports" | "allowed_ips" | "ssh_enabled"
>;

export function policyBody(
  policy: NetworkPolicy,
  patch: Partial<NetworkPolicyBody> = {},
): NetworkPolicyBody {
  return {
    internet: patch.internet ?? policy.internet,
    open_mode: patch.open_mode ?? policy.open_mode,
    open_ports: [...(patch.open_ports ?? policy.open_ports)],
    allowed_ips: [...(patch.allowed_ips ?? policy.allowed_ips)],
    ssh_enabled: patch.ssh_enabled ?? policy.ssh_enabled,
  };
}

export const MODE_OPTIONS: ReadonlyArray<{
  readonly value: OpenMode;
  readonly title: string;
  readonly description: string;
}> = [
  {
    value: "all",
    title: "Everything you've opened",
    description: "Apps and ports answer from anywhere, as you set them up.",
  },
  {
    value: "ports",
    title: "Only the ports you choose",
    description: "Everything else stops answering from the internet.",
  },
  {
    value: "allowlist",
    title: "Only from these addresses",
    description: "Apps, ports and SSH answer only to the addresses on your list.",
  },
  {
    value: "vpn",
    title: "Only through your own private network (VPN)",
    description: "Nothing answers from the internet except the VPN itself.",
  },
];

export function portTitle(port: NetworkPort): string {
  switch (port.kind) {
    case "uno_work":
      return "Uno Work";
    case "ssh":
      return "SSH";
    case "vpn":
      return port.app_name ? `${port.app_name} (VPN)` : "VPN";
    default:
      return (
        port.app_name ?? `Port ${port.internal_port}${port.protocol === "udp" ? " (UDP)" : ""}`
      );
  }
}

/**
 * Ports for "Only the ports you choose": one row per inside port number (the
 * policy picks by that number). Uno Work and SSH have their own rows above.
 */
export function choosablePorts(
  ports: ReadonlyArray<NetworkPort>,
): ReadonlyArray<{ readonly internalPort: number; readonly title: string }> {
  const seen = new Set<number>();
  const out: Array<{ internalPort: number; title: string }> = [];
  for (const port of ports) {
    if (port.kind === "uno_work" || port.kind === "ssh" || seen.has(port.internal_port)) continue;
    seen.add(port.internal_port);
    out.push({ internalPort: port.internal_port, title: portTitle(port) });
  }
  return out.toSorted((a, b) => a.internalPort - b.internalPort);
}

export function toggledPorts(
  current: ReadonlyArray<number>,
  port: number,
  on: boolean,
): ReadonlyArray<number> {
  const set = new Set(current);
  if (on) set.add(port);
  else set.delete(port);
  return [...set].toSorted((a, b) => a - b);
}

export interface ReachabilityRow {
  readonly key: number;
  readonly title: string;
  readonly address: string;
  readonly status: PortAccess;
  readonly statusLabel: string;
}

const STATUS_LABEL: Record<PortAccess, string> = {
  public: "Open to everyone",
  allowlist: "Only your addresses",
  private: "Closed",
};

/** "Reachable from the internet right now": open first, closed last. */
export function reachability(ports: ReadonlyArray<NetworkPort>): ReadonlyArray<ReachabilityRow> {
  const rank: Record<PortAccess, number> = { public: 0, allowlist: 1, private: 2 };
  return ports
    .map((port) => ({
      key: port.id,
      title: portTitle(port),
      address: port.address,
      status: port.effective,
      statusLabel: STATUS_LABEL[port.effective],
    }))
    .toSorted((a, b) => rank[a.status] - rank[b.status]);
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An IPv4 address or network ("1.2.3.4", "10.0.0.0/8"), tidied; null if not one. */
export function normalizeAddress(raw: string): string | null {
  const value = raw.trim();
  const [ip = "", bits, ...rest] = value.split("/");
  if (rest.length > 0) return null;
  const match = IPV4.exec(ip);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return null;
  const address = octets.join(".");
  if (bits === undefined) return address;
  if (!/^\d{1,2}$/.test(bits) || Number(bits) > 32) return null;
  return `${address}/${Number(bits)}`;
}

export const MAX_ADDRESSES = 64;

export function addAddress(
  list: ReadonlyArray<string>,
  raw: string,
): { readonly list: ReadonlyArray<string>; readonly error: string | null } {
  const address = normalizeAddress(raw);
  if (address === null) {
    return { list, error: "Type an address like 203.0.113.7 or a network like 203.0.113.0/24." };
  }
  if (list.includes(address)) return { list, error: null };
  if (list.length >= MAX_ADDRESSES) {
    return { list, error: `Up to ${MAX_ADDRESSES} addresses.` };
  }
  return { list: [...list, address], error: null };
}

export function sameAddresses(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Server error codes → words for a person. */
export function networkErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes("INVALID_ALLOWLIST")) return "Add at least one valid address first.";
  if (text.includes("INVALID_PORTS"))
    return "One of those ports no longer exists. Refresh and try again.";
  if (text.includes("NETWORK_POLICY_UNSUPPORTED")) return "This computer can't be set up this way.";
  return text;
}
