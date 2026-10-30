/**
 * Sidebar pins as data: add, remove, find — kept free of React so the rules
 * are tested directly. Pins live in the computer's settings (`pins`, see
 * `UnoPin` in contracts); chats are pinned on the chat itself.
 */
import { MAX_UNO_PINS, type UnoPin, type UnoPinKind } from "@t3tools/contracts";

/**
 * A built-in Home widget in the pins. Stored as an app pin with its own
 * address, not as a new `kind`: settings.json that an older daemon can't decode
 * falls back to all defaults, and an update can roll back by itself.
 */
const WIDGET_PIN_PREFIX = "uno-widget:";

export function widgetPinTarget(widgetId: string): string {
  return `${WIDGET_PIN_PREFIX}${widgetId}`;
}

/** The Home widget this pin stands for; null for any other pin. */
export function pinnedWidgetId(pin: Pick<UnoPin, "kind" | "target">): string | null {
  return pin.kind === "app" && pin.target.startsWith(WIDGET_PIN_PREFIX)
    ? pin.target.slice(WIDGET_PIN_PREFIX.length)
    : null;
}

export function pinIdFor(kind: UnoPinKind, target: string): string {
  return `${kind}:${target}`;
}

export function findPin(
  pins: ReadonlyArray<UnoPin>,
  kind: UnoPinKind,
  target: string,
): UnoPin | null {
  const id = pinIdFor(kind, target);
  return pins.find((pin) => pin.id === id) ?? null;
}

/** Adds a pin at the end; an existing pin for the same thing is kept, not doubled. */
export function addPin(pins: ReadonlyArray<UnoPin>, pin: Omit<UnoPin, "id">): UnoPin[] {
  const id = pinIdFor(pin.kind, pin.target);
  if (pins.some((existing) => existing.id === id)) return [...pins];
  const next = [...pins, { ...pin, id, title: pin.title.slice(0, 200) }];
  // The oldest pins give way first: a sidebar of 50 pins is not a sidebar.
  return next.slice(-MAX_UNO_PINS);
}

export function removePin(pins: ReadonlyArray<UnoPin>, id: string): UnoPin[] {
  return pins.filter((pin) => pin.id !== id);
}

export function renamePin(pins: ReadonlyArray<UnoPin>, id: string, title: string): UnoPin[] {
  const trimmed = title.trim();
  if (!trimmed) return [...pins];
  return pins.map((pin) => (pin.id === id ? { ...pin, title: trimmed.slice(0, 200) } : pin));
}

/**
 * What a person types into "Pin a link" → a web address, or null. Bare
 * domains get https://; anything that isn't http(s) is refused (no
 * `javascript:` links in the sidebar).
 */
export function normalizeLinkInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** A readable default title for a link: its host without "www.". */
export function linkTitle(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Last path segment, for file and folder pins. */
export function pathTitle(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || "/";
}

/** One icon of the pin row with its gap, in pixels. */
const PIN_ICON_PX = 30;

/**
 * Pins that get an icon in a row `width` wide, and the rest, which go under
 * "More". The "More" button takes the last place when it's needed.
 */
export function splitRowPins<T>(
  pins: ReadonlyArray<T>,
  width: number,
): { readonly shown: ReadonlyArray<T>; readonly rest: ReadonlyArray<T> } {
  const slots = Math.max(1, Math.floor(width / PIN_ICON_PX));
  if (pins.length <= slots) return { shown: pins, rest: [] };
  const kept = slots - 1;
  return { shown: pins.slice(0, kept), rest: pins.slice(kept) };
}
