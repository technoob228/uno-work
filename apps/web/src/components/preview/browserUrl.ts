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
