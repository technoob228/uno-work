/**
 * Variant C: the fake daemon's faces — a persona portrait drawn on request
 * (`/api/manager/assistant/avatar/generate`, fails in `face=fail`), and the
 * picture an assistant keeps (`/api/manager/assistant/avatar`).
 *
 * The portrait is a flat friendly SVG drawn here (Human / Animal / Robot /
 * Alien; the seed changes the background, colours and small details), sent
 * after ~1.2 s like Uno AI would. A kept picture lives in memory per
 * computer and folder; `avatarOf` gives the file name the summary shows.
 */
import { HttpResponse, http, type HttpHandler } from "msw";

import { MACHINE_LIST, PRIMARY_MACHINE, type MachineKey } from "../../heavyFixtures";
import { WORLD } from "../world";

type Persona = "human" | "animal" | "robot" | "alien";
const PERSONAS: ReadonlyArray<Persona> = ["human", "animal", "robot", "alien"];

// ── The portrait ──────────────────────────────────────────────────────────

const BACKGROUNDS = ["#FDE7C7", "#D7F0E9", "#E3E1FB", "#FBDDE3", "#D9ECFB", "#E6F4D7", "#F3E6D8"];
const SKINS = ["#F6D2B5", "#E8B48F", "#C98E64", "#9C6644", "#F1C7A1"];
const HAIRS = ["#2E2A27", "#6B3E26", "#C68B4E", "#E2B35B", "#9A3B2E", "#5B5B66"];
const SHIRTS = ["#5B6CF0", "#2BA39A", "#E0794B", "#C2468A", "#3D8BD9", "#7A5AE0"];
const FURS = ["#E58A3C", "#8F8F96", "#B7834F", "#2F2F33", "#D8C6A8"];
const METALS = ["#B9C3CF", "#9FB6C9", "#C8BCD6", "#AFC8BB"];
const GLOWS = ["#38BDF8", "#34D399", "#F59E0B", "#F472B6"];
const ALIENS = ["#8BD67A", "#7CC8D9", "#B79BE8", "#9ADBB3"];

/** A small deterministic generator from the seed (same seed, same face). */
function random(seed: number) {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 10_000) / 10_000;
  };
}

function portraitSvg(persona: Persona, seed: number): string {
  const next = random(seed + PERSONAS.indexOf(persona) * 7919);
  const pick = <T>(list: ReadonlyArray<T>) => list[Math.floor(next() * list.length)]!;
  const bg = pick(BACKGROUNDS);
  const eyes = (y: number, gap: number, r: number, color = "#262626") =>
    `<circle cx="${128 - gap}" cy="${y}" r="${r}" fill="${color}"/><circle cx="${128 + gap}" cy="${y}" r="${r}" fill="${color}"/>`;
  const smile = (y: number, w: number, color = "#262626") =>
    `<path d="M${128 - w} ${y} Q128 ${y + w * 0.8} ${128 + w} ${y}" stroke="${color}" stroke-width="5" fill="none" stroke-linecap="round"/>`;
  const cheeks = (y: number, gap: number) =>
    `<circle cx="${128 - gap}" cy="${y}" r="9" fill="#F28B9B" opacity=".45"/><circle cx="${128 + gap}" cy="${y}" r="9" fill="#F28B9B" opacity=".45"/>`;
  let body = "";
  if (persona === "human") {
    const skin = pick(SKINS);
    const hair = pick(HAIRS);
    const shirt = pick(SHIRTS);
    const long = next() > 0.5;
    body = [
      `<path d="M48 256 Q52 186 128 182 Q204 186 208 256Z" fill="${shirt}"/>`,
      `<rect x="112" y="150" width="32" height="40" rx="12" fill="${skin}"/>`,
      long ? `<path d="M70 120 Q66 196 92 206 L164 206 Q190 196 186 120Z" fill="${hair}"/>` : "",
      `<circle cx="128" cy="116" r="54" fill="${skin}"/>`,
      `<path d="M74 112 Q76 58 128 58 Q182 58 182 112 Q160 84 128 88 Q96 84 74 112Z" fill="${hair}"/>`,
      eyes(118, 20, 6),
      cheeks(134, 32),
      smile(138, 14),
    ].join("");
  } else if (persona === "animal") {
    const fur = pick(FURS);
    const round = next() > 0.5;
    const ears = round
      ? `<circle cx="80" cy="74" r="24" fill="${fur}"/><circle cx="176" cy="74" r="24" fill="${fur}"/><circle cx="80" cy="74" r="12" fill="#F6C9B6"/><circle cx="176" cy="74" r="12" fill="#F6C9B6"/>`
      : `<path d="M66 108 L80 42 L118 80Z" fill="${fur}"/><path d="M190 108 L176 42 L138 80Z" fill="${fur}"/><path d="M80 92 L86 60 L104 80Z" fill="#F6C9B6"/><path d="M176 92 L170 60 L152 80Z" fill="#F6C9B6"/>`;
    body = [
      `<path d="M56 256 Q60 196 128 192 Q196 196 200 256Z" fill="${fur}" opacity=".9"/>`,
      ears,
      `<circle cx="128" cy="124" r="62" fill="${fur}"/>`,
      `<ellipse cx="128" cy="148" rx="34" ry="26" fill="#FFF4EA"/>`,
      eyes(116, 24, 7),
      `<ellipse cx="128" cy="138" rx="9" ry="6" fill="#3B2A24"/>`,
      `<path d="M120 152 Q128 160 136 152" stroke="#3B2A24" stroke-width="4" fill="none" stroke-linecap="round"/>`,
    ].join("");
  } else if (persona === "robot") {
    const metal = pick(METALS);
    const glow = pick(GLOWS);
    const square = next() > 0.5;
    body = [
      `<rect x="64" y="196" width="128" height="70" rx="22" fill="${metal}"/>`,
      `<rect x="116" y="174" width="24" height="28" fill="#8C96A3"/>`,
      `<line x1="128" y1="62" x2="128" y2="36" stroke="#8C96A3" stroke-width="6"/>`,
      `<circle cx="128" cy="32" r="9" fill="${glow}"/>`,
      `<rect x="60" y="104" width="14" height="36" rx="6" fill="#8C96A3"/><rect x="182" y="104" width="14" height="36" rx="6" fill="#8C96A3"/>`,
      `<rect x="70" y="62" width="116" height="116" rx="${square ? 18 : 40}" fill="${metal}"/>`,
      `<rect x="86" y="86" width="84" height="48" rx="20" fill="#273142"/>`,
      eyes(110, 20, 9, glow),
      `<rect x="102" y="148" width="52" height="12" rx="6" fill="#273142"/>`,
      `<line x1="115" y1="148" x2="115" y2="160" stroke="${metal}" stroke-width="3"/><line x1="128" y1="148" x2="128" y2="160" stroke="${metal}" stroke-width="3"/><line x1="141" y1="148" x2="141" y2="160" stroke="${metal}" stroke-width="3"/>`,
    ].join("");
  } else {
    const skin = pick(ALIENS);
    const antennae = next() > 0.4;
    body = [
      `<path d="M60 256 Q64 200 128 196 Q192 200 196 256Z" fill="${pick(SHIRTS)}"/>`,
      antennae
        ? `<path d="M100 70 Q90 40 76 34" stroke="${skin}" stroke-width="6" fill="none" stroke-linecap="round"/><path d="M156 70 Q166 40 180 34" stroke="${skin}" stroke-width="6" fill="none" stroke-linecap="round"/><circle cx="76" cy="34" r="8" fill="${skin}"/><circle cx="180" cy="34" r="8" fill="${skin}"/>`
        : "",
      `<path d="M128 56 Q196 56 192 126 Q186 186 128 192 Q70 186 64 126 Q60 56 128 56Z" fill="${skin}"/>`,
      `<ellipse cx="100" cy="122" rx="20" ry="13" transform="rotate(28 100 122)" fill="#1F2430"/>`,
      `<ellipse cx="156" cy="122" rx="20" ry="13" transform="rotate(-28 156 122)" fill="#1F2430"/>`,
      `<circle cx="94" cy="118" r="4" fill="#fff"/><circle cx="150" cy="118" r="4" fill="#fff"/>`,
      smile(160, 10, "#2A3A2A"),
    ].join("");
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="${bg}"/>${body}</svg>`;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

// ── What a computer keeps ─────────────────────────────────────────────────

const kept = new Map<
  string,
  { readonly name: string; readonly type: string; readonly bytes: Uint8Array }
>();
const keyOf = (machine: MachineKey, projectId: string) => `${machine}:${projectId}`;

function machineKeyOf(request: Request): MachineKey {
  const host = new URL(request.url).host;
  return (
    MACHINE_LIST.find((machine) => machine.host !== "" && machine.host === host) ?? PRIMARY_MACHINE
  ).key;
}

/** The kept picture's file name for the summary (`profile.avatar`), or null: its emoji shows. */
export function avatarOf(machine: MachineKey, projectId: string): string | null {
  return kept.get(keyOf(machine, projectId))?.name ?? null;
}

function typeOf(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x3c) return "image/svg+xml";
  return "image/webp";
}

function decode(base64: string): Uint8Array | null {
  try {
    const raw = atob(base64.replace(/^data:[^,]*,/, ""));
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  return ((await request.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
}

const DRAW_MS = 1_200;

export function avatarHandlers(): HttpHandler[] {
  return [
    http.post("*/api/manager/assistant/avatar/generate", async ({ request }) => {
      const body = await bodyOf(request);
      await new Promise((resolve) => setTimeout(resolve, DRAW_MS));
      if (WORLD.face === "fail") {
        return HttpResponse.json({ error: "Uno AI couldn't draw it right now" }, { status: 503 });
      }
      const persona = PERSONAS.includes(body.persona as Persona)
        ? (body.persona as Persona)
        : "human";
      const seed = typeof body.seed === "number" ? body.seed : Date.now();
      return HttpResponse.json({ image: svgDataUrl(portraitSvg(persona, seed)) });
    }),
    http.post("*/api/manager/assistant/avatar", async ({ request }) => {
      const body = await bodyOf(request);
      const key = keyOf(machineKeyOf(request), String(body.projectId ?? ""));
      const bytes = typeof body.image === "string" ? decode(body.image) : null;
      if (!bytes) {
        kept.delete(key);
        return HttpResponse.json({ avatar: null });
      }
      const type = typeOf(bytes);
      const name = `avatar-${Date.now()}.${type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : "webp"}`;
      kept.set(key, { name, type, bytes });
      return HttpResponse.json({ avatar: name });
    }),
    http.get("*/api/manager/assistant/avatar", ({ request }) => {
      const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
      const picture = kept.get(keyOf(machineKeyOf(request), projectId));
      if (!picture) return new HttpResponse(null, { status: 404 });
      return new HttpResponse(picture.bytes.slice().buffer, {
        status: 200,
        headers: { "content-type": picture.type },
      });
    }),
  ];
}
