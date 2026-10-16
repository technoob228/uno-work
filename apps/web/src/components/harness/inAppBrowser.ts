/**
 * In-app browsers (Telegram, Instagram, Facebook, LINE): signing in to Uno
 * through Telegram opens Uno Work in Telegram's own browser, where the person
 * is not signed in to Claude or ChatGPT — the CLI's sign-in link has to go to
 * their usual browser. A web page can't force that, so the sign-in says it
 * and offers "Copy link" (HarnessSignInDialog).
 *
 * The desktop app opens links in the system browser already (main.ts
 * setWindowOpenHandler / shell.openExternal): never "in-app" there.
 */
const IN_APP_UA: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bTelegram\b/i, "Telegram"],
  [/\bInstagram\b/i, "Instagram"],
  [/\bFBA[NV]\//, "Facebook"],
  [/\bLine\//, "LINE"],
];

/** The in-app browser's name, or null in a regular browser / the desktop app. */
export function inAppBrowserName(
  env: {
    readonly userAgent?: string;
    readonly telegramWebview?: boolean;
    readonly desktop?: boolean;
  } = readEnv(),
): string | null {
  if (env.desktop) return null;
  if (env.telegramWebview) return "Telegram";
  const ua = env.userAgent ?? "";
  for (const [pattern, name] of IN_APP_UA) {
    if (pattern.test(ua)) return name;
  }
  return null;
}

function readEnv(): { userAgent?: string; telegramWebview?: boolean; desktop?: boolean } {
  if (typeof window === "undefined") return {};
  const w = window as unknown as { TelegramWebviewProxy?: unknown; desktopBridge?: unknown };
  return {
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    // Telegram's iOS / Android in-app browser injects this object.
    telegramWebview: w.TelegramWebviewProxy !== undefined,
    desktop: w.desktopBridge !== undefined,
  };
}
