/**
 * Адресная строка встроенного браузера: нормализация пользовательского ввода
 * в загружаемый URL и человекочитаемые подписи вкладок.
 */

const HTTP_SCHEME_RE = /^https?:\/\//i;
const ANY_SCHEME_WITH_SLASHES_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isProbablyHost(input: string): boolean {
  if (/\s/.test(input)) return false;
  const hostPart = input.split(/[/?#]/, 1)[0] ?? "";
  if (hostPart === "localhost" || hostPart.startsWith("localhost:")) return true;
  // IPv4 c опциональным портом
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(hostPart)) return true;
  // domain.tld c опциональным портом
  return /^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(hostPart);
}

function isLoopbackHost(input: string): boolean {
  const hostPart = input.split(/[/?#]/, 1)[0] ?? "";
  return (
    hostPart === "localhost" ||
    hostPart.startsWith("localhost:") ||
    hostPart === "127.0.0.1" ||
    hostPart.startsWith("127.0.0.1:")
  );
}

/**
 * Превращает ввод адресной строки в URL: добавляет схему голым хостам
 * (loopback получает http, остальные https), а всё, что не похоже на адрес,
 * отправляет в поисковик. Возвращает null для пустого ввода.
 */
export function normalizeBrowserUrl(rawInput: string): string | null {
  const input = rawInput.trim();
  if (!input) return null;
  // Полный http(s)-адрес — берём как есть.
  if (HTTP_SCHEME_RE.test(input)) {
    try {
      const url = new URL(input);
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
      return null;
    } catch {
      return null;
    }
  }
  // Любая другая схема с `://` (chrome://, file://, ftp://) — запрещена.
  if (ANY_SCHEME_WITH_SLASHES_RE.test(input)) return null;
  // Голый хост (`localhost:5173`, `127.0.0.1:8081`, `domain.tld`) — проверяем
  // до схемного двоеточия, иначе порт принимается за схему.
  if (isProbablyHost(input)) {
    const scheme = isLoopbackHost(input) ? "http" : "https";
    try {
      return new URL(`${scheme}://${input}`).toString();
    } catch {
      return null;
    }
  }
  // Не-веб схема без слешей (javascript:, mailto:) — запрещена.
  if (SCHEME_RE.test(input)) return null;
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

/** Подпись вкладки до прихода заголовка страницы: хост без "www.". */
export function browserTabNameForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    return host || url;
  } catch {
    return url;
  }
}

/** Origin для подбора сохранённых кредов; null для невалидных URL. */
export function browserUrlOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Санитизация ключа проекта для имени persist-партиции Electron. */
export function browserPartitionForScope(input: {
  scope: "account" | "project";
  projectKey: string | null;
}): string {
  if (input.scope === "project" && input.projectKey) {
    const safeKey = input.projectKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
    return `persist:uno-browser-p-${safeKey}`;
  }
  return "persist:uno-browser";
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return null;
  return octets as [number, number, number, number];
}

/**
 * Whether a URL points at this computer or its local network: localhost,
 * loopback, RFC 1918, link-local, CGNAT/Tailscale (100.64/10), unspecified,
 * IPv6 loopback / unique-local / link-local. Only literal hosts are
 * recognised; a public name that resolves to a private address is not.
 */
export function isPrivateNetworkUrl(rawUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const v6 = hostname.slice(1, -1);
    if (v6 === "::1" || v6 === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    return mapped?.[1] ? isPrivateNetworkUrl(`http://${mapped[1]}/`) : false;
  }
  const ip = parseIpv4(hostname);
  if (!ip) return false;
  const [a, b] = ip;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * An address an agent (or a plugin) asked the embedded browser to open:
 * normalised to http(s), or null when it must not be opened at all
 * (file:, javascript:, chrome:, devtools:, …).
 */
export function normalizeAgentBrowserUrl(rawUrl: string | undefined): string | null {
  const trimmed = rawUrl?.trim() ?? "";
  if (!trimmed) return null;
  const url = normalizeBrowserUrl(trimmed);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return url;
}

export const AGENT_PRIVATE_URL_MESSAGE =
  "Opening an address on this computer or its local network needs the user's confirmation; they were asked in the app.";
