/**
 * Общая часть команды `screenshot` для обоих исполнителей bridge: Electron
 * `<webview>` в клиенте (`capturePage`) и серверный headless Chromium
 * (`page.screenshot`).
 *
 * Главное здесь — распознать пустой кадр. Скрытая/не композитящаяся webview
 * возвращает пустой `NativeImage`, у которого `toDataURL()` даёт один префикс
 * `data:image/png;base64,` без payload. Строка непустая, поэтому наивная
 * проверка `if (!dataUrl)` пропускает её дальше и харнесс получает `ok: true`
 * с нулевым PNG.
 */

export const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/** Минимальный PNG (1×1) — ~70 байт; всё, что меньше, кадром быть не может. */
const MIN_SCREENSHOT_BYTES = 64;

/** Маркер в тексте ошибки, по которому роутер решает делать фолбэк. */
export const EMPTY_FRAME_ERROR_CODE = "empty_frame";

export type ScreenshotCapturedBy = "panel" | "headless";

export interface ScreenshotResultData {
  readonly dataUrl: string;
  /** Размер PNG в байтах — по нему видно пустой кадр без декодирования. */
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly fullPage: boolean;
  /** Каким путём снят кадр: панель приложения или серверный Chromium. */
  readonly capturedBy: ScreenshotCapturedBy;
  /** Заполняется, когда кадр снят серверным браузером после пустого в панели. */
  readonly fallbackFrom?: ScreenshotCapturedBy;
  /** URL страницы, с которой реально снят кадр (важно при фолбэке). */
  readonly url?: string;
}

export function pngDataUrl(base64: string): string {
  return `${PNG_DATA_URL_PREFIX}${base64}`;
}

/** Размер PNG в байтах по длине base64-хвоста data URL; 0 — пустой кадр. */
export function screenshotBytes(dataUrl: string | undefined): number {
  if (!dataUrl) return 0;
  const separator = dataUrl.indexOf(",");
  const payload = separator >= 0 ? dataUrl.slice(separator + 1) : "";
  if (payload.length === 0) return 0;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export function isEmptyScreenshot(dataUrl: string | undefined): boolean {
  return screenshotBytes(dataUrl) < MIN_SCREENSHOT_BYTES;
}

export function emptyFrameMessage(input: {
  readonly capturedBy: ScreenshotCapturedBy;
  readonly attempts: number;
  readonly bytes: number;
}): string {
  const where =
    input.capturedBy === "panel"
      ? "the embedded browser panel returned a blank frame (tab not composited: hidden panel, minimized window, or another project selected)"
      : "the headless browser returned a blank frame";
  return `${EMPTY_FRAME_ERROR_CODE}: ${where}; ${input.attempts} attempt(s), ${input.bytes} bytes.`;
}

/** Ошибка от исполнителя — пустой кадр? Основание для фолбэка на headless. */
export function isEmptyFrameError(error: string | undefined): boolean {
  return typeof error === "string" && error.includes(EMPTY_FRAME_ERROR_CODE);
}

/**
 * Успешный результат `screenshot`, у которого dataUrl на деле пуст — так
 * отвечают клиенты старых версий, ещё не знающие про валидацию кадра.
 */
export function isEmptyScreenshotResultData(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const dataUrl = (data as { dataUrl?: unknown }).dataUrl;
  return typeof dataUrl === "string" && isEmptyScreenshot(dataUrl);
}
