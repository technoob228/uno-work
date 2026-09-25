/**
 * Outbound requests to addresses a person typed (an MCP server URL, a link to
 * read): http(s) only, and never into the cloud's metadata service or other
 * link-local addresses — on a cloud computer those hand out instance
 * credentials to whoever asks from inside the machine.
 *
 * Every hop of a redirect is checked again. Known gap: the host is resolved
 * here and then again by `fetch`, so a DNS answer that changes between the two
 * (rebinding) isn't caught; the metadata addresses aren't reachable through a
 * public name in practice, which is what this guard is for.
 *
 * @module setupTools/netGuard
 */
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

export class NetGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetGuardError";
  }
}

export type HostLookup = (hostname: string) => Promise<ReadonlyArray<string>>;

const defaultLookup: HostLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

function ipv4Octets(address: string): ReadonlyArray<number> | null {
  if (!net.isIPv4(address)) return null;
  return address.split(".").map(Number);
}

/** The 16 bytes of an IPv6 address (with an embedded IPv4 tail expanded). */
function ipv6Bytes(address: string): Uint8Array | null {
  if (!net.isIPv6(address)) return null;
  let text = address.split("%")[0]!.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const octets = ipv4Octets(v4[1]!);
    if (!octets) return null;
    text = `${text.slice(0, -v4[1]!.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${(
      (octets[2]! << 8) |
      octets[3]!
    ).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const headParts = head.length > 0 ? head.split(":") : [];
  const tailParts = tail !== undefined && tail.length > 0 ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (tail === undefined ? headParts.length !== 8 : missing < 0) return null;
  const parts = [...headParts, ...Array.from({ length: missing }, () => "0"), ...tailParts];
  const bytes = new Uint8Array(16);
  parts.forEach((part, index) => {
    const value = Number.parseInt(part, 16);
    bytes[index * 2] = (value >> 8) & 0xff;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

const EC2_METADATA_V6 = ipv6Bytes("fd00:ec2::254")!;

/** Link-local (169.254.0.0/16, fe80::/10) and the cloud metadata addresses. */
export function isForbiddenAddress(address: string): boolean {
  const v4 = ipv4Octets(address);
  if (v4) return v4[0] === 169 && v4[1] === 254;
  const v6 = ipv6Bytes(address);
  if (!v6) return false;
  if (v6[0] === 0xfe && (v6[1]! & 0xc0) === 0x80) return true;
  if (v6.every((byte, index) => byte === EC2_METADATA_V6[index])) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms.
  const mapped = v6.slice(0, 10).every((byte) => byte === 0) && v6[10] === 0xff && v6[11] === 0xff;
  const compatible = v6.slice(0, 12).every((byte) => byte === 0);
  if (mapped || compatible) return v6[12] === 169 && v6[13] === 254;
  return false;
}

/** Parses and checks a URL a person gave; throws `NetGuardError` in plain words. */
export function parsePublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new NetGuardError("That isn't a web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NetGuardError("Only http:// and https:// addresses work here.");
  }
  if (url.username || url.password) {
    throw new NetGuardError("Addresses with a user name or password in them aren't allowed.");
  }
  return url;
}

export async function assertAllowedHost(url: URL, lookup: HostLookup = defaultLookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(hostname) ? [hostname] : await lookup(hostname).catch(() => []);
  if (addresses.length === 0) throw new NetGuardError(`Couldn't find ${hostname}.`);
  if (addresses.some(isForbiddenAddress)) {
    throw new NetGuardError("That address points into the cloud's internal network.");
  }
}

export interface GuardedFetchOptions {
  readonly fetch?: typeof fetch;
  readonly lookup?: HostLookup;
  readonly maxRedirects?: number;
}

/** `fetch` that checks the target (and every redirect) first. */
export async function guardedFetch(
  raw: string | URL,
  init: RequestInit,
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  let url = typeof raw === "string" ? parsePublicHttpUrl(raw) : raw;
  let request = init;
  for (let hop = 0; ; hop += 1) {
    await assertAllowedHost(url, options.lookup);
    const response = await fetchImpl(url, { ...request, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return response;
    if (hop >= (options.maxRedirects ?? 3)) throw new NetGuardError("Too many redirects.");
    await response.body?.cancel().catch(() => undefined);
    url = parsePublicHttpUrl(new URL(location, url).toString());
    // 303 (and the historical 301/302 on POST) turn into a GET.
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && request.method === "POST")
    ) {
      const { body: _body, ...rest } = request;
      request = { ...rest, method: "GET" };
    }
  }
}

/** Reads at most `maxBytes` of a body; `truncated` says whether more was there. */
export async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}
