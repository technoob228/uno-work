/**
 * Demo data for point 1–2 of the w0138 mock (the panel's launcher and the
 * browsers): the apps on each computer, the person's sites, the agent's
 * browser on the cloud computers (a still frame of the test page with the
 * agent's cursor), and the test site's broken backend (`/api/order` → 500,
 * a missing image → 404). demoBoot.ts asks these from its RPC and HTTP mocks.
 */
import {
  type BrowserLivePage,
  type BrowserLiveState,
  type UnoMachineApp,
  type UnoMachineApps,
  type UnoWorkSites,
  WS_METHODS,
} from "@t3tools/contracts";
import { HttpResponse, delay, http } from "msw";

import { demoHooks } from "./demoFlag";
import type { NormalizedWsRpcRequestBody } from "./rpcHarness";
import { type DemoMachine, machineByEnv } from "./heavyFixtures";

/** An address of the test site / mock apps, served next to the app. */
export function demoSiteUrl(path: string): string {
  return new URL(`demo-site/${path}`, `${location.origin}${import.meta.env.BASE_URL}`).href;
}

// ── Apps on each computer ────────────────────────────────────────────────

function app(
  id: string,
  name: string,
  icon: string,
  detail: string,
  url: string | null,
  status: UnoMachineApp["status"] = "running",
): UnoMachineApp {
  return {
    id: `manifest:${id}`,
    source: "manifest",
    name,
    description: detail,
    icon,
    iconImage: null,
    status,
    port: 8600 + id.length,
    udpPorts: [],
    http: true,
    loopbackOnly: false,
    detail,
    url,
    localUrl: null,
    publication: null,
    canStart: true,
    canStop: true,
    canRemove: true,
    codeDir: `~/projects/${id}`,
  };
}

const APPS_BY_MACHINE: Record<DemoMachine["key"], () => UnoMachineApp[]> = {
  own: () => [],
  product: () => [
    app("pult", "Пульт", "🎛", "Agents, questions and reports", demoSiteUrl("apps/pult.html")),
  ],
  work: () => [
    // Prototype 29.10: pinned apps with a Home widget (the peek on hover).
    {
      ...app(
        "shop-sales",
        "Продажи магазина",
        "📈",
        "Orders and revenue of shop-site",
        demoSiteUrl("apps/sales/"),
      ),
      widget: { path: "/widget.html", size: "medium", title: "Продажи сегодня" },
    },
    {
      ...app(
        "support-bot",
        "Бот поддержки",
        "🤖",
        "Telegram support bot of the shop",
        demoSiteUrl("apps/support/"),
      ),
      widget: { path: "/widget.html", size: "medium", title: "Ждут ответа" },
    },
    app(
      "ai-limits",
      "Лимиты нейронок",
      "📊",
      "Claude, Codex and Uno AI limits",
      demoSiteUrl("apps/ai-limits.html"),
    ),
    app("grafana-nodes", "Grafana · nodes", "📈", "Load of hector and nl-2", null, "stopped"),
  ],
  mac: () => [
    app(
      "offer-campaign",
      "Рассылки · offer-campaign",
      "📬",
      "Mail campaign dashboard",
      demoSiteUrl("apps/offer-campaign.html"),
    ),
  ],
};

export function demoMachineApps(machine: DemoMachine): UnoMachineApps {
  return {
    apps: APPS_BY_MACHINE[machine.key](),
    manifestDir: "~/.uno/apps",
    scannedAt: new Date().toISOString(),
    publishBlockedReason: null,
    warnings: [],
  };
}

// ── Sites ────────────────────────────────────────────────────────────────

/** A site's real-looking address → the page the demo shows for it. */
const SITE_PAGES: Record<string, string> = {
  "https://fieldnote.uno4.me/": "index.html",
  "https://misha-week-1015.uno4.me/": "apps/pult.html",
  "https://landing-3flows.uno4.me/": "pricing.html",
};

export function demoSiteOpenUrl(url: string): string {
  const page = SITE_PAGES[url];
  return page ? demoSiteUrl(page) : url;
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

export function demoWorkSites(): UnoWorkSites {
  return {
    availability: "ok",
    sites: [
      {
        slug: "fieldnote",
        url: "https://fieldnote.uno4.me/",
        customDomain: null,
        hasPassword: false,
        sizeBytes: 182_000,
        updatedAt: hoursAgo(1),
        madeIn: { threadId: "l-copy", title: "Landing copy — three flows" },
      },
      {
        slug: "landing-3flows",
        url: "https://landing-3flows.uno4.me/",
        customDomain: null,
        hasPassword: true,
        sizeBytes: 640_000,
        updatedAt: hoursAgo(5),
      },
      {
        slug: "misha-week-1015",
        url: "https://misha-week-1015.uno4.me/",
        customDomain: null,
        hasPassword: true,
        sizeBytes: 96_000,
        updatedAt: hoursAgo(26),
      },
    ],
    storageUsedBytes: 918_000,
    storageLimitBytes: 1_073_741_824,
    message: null,
  };
}

// ── The agent's browser on the cloud computers ───────────────────────────

let frameData: string | null = null;

/** The still frame of the agent's browser (the test page with its cursor), read once at start. */
export async function loadAgentFrame(): Promise<void> {
  try {
    const response = await fetch(demoSiteUrl("agent-frame.jpg"));
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    frameData = btoa(binary);
  } catch {
    frameData = null;
  }
  await loadSignInAssets();
}

const liveStates = new Map<string, BrowserLiveState>();

function livePage(
  machine: DemoMachine,
  pageId: string,
  threadId: string,
  url: string,
): BrowserLivePage {
  return {
    pageId,
    url,
    title: "Pricing — Fieldnote",
    context: { threadId, cwd: `${machine.home}/projects/landing` },
    control: "agent",
    help: null,
    attention: 0,
    agentWaiting: false,
    width: 1280,
    height: 800,
  };
}

function liveStateFor(machine: DemoMachine): BrowserLiveState {
  let state = liveStates.get(machine.environmentId);
  if (!state) {
    state = {
      agentsBrowseHere: true,
      location: {
        machine: machine.label,
        publicIp: machine.key === "product" ? "185.231.68.14" : "185.231.68.22",
        display: "headful",
        running: true,
        country: "NL",
        proxy: null,
      },
      setup: { status: "ready", step: null, startedAt: null, secondsLeft: null, error: null },
      // The landing chat's agent is checking the pricing page right now.
      pages:
        machine.key === "product"
          ? [
              livePage(
                machine,
                "page-pricing",
                "s-pricing",
                "https://landing-3flows.uno4.me/pricing",
              ),
            ]
          : [],
    };
    liveStates.set(machine.environmentId, state);
  }
  return state;
}

type Emit = (method: string, value: unknown) => void;

function update(machine: DemoMachine, next: BrowserLiveState, emit: Emit): BrowserLiveState {
  liveStates.set(machine.environmentId, next);
  setTimeout(() => emit(WS_METHODS.subscribeBrowserLive, next), 20);
  return next;
}

const LIVE_METHODS = new Set<string>([
  WS_METHODS.browserLiveOpen,
  WS_METHODS.browserLiveSetControl,
  WS_METHODS.browserLiveNavigate,
  WS_METHODS.browserLiveInput,
  WS_METHODS.browserLiveResize,
  WS_METHODS.browserLiveClose,
  WS_METHODS.browserLiveSetup,
  WS_METHODS.browserLiveSetProxy,
  WS_METHODS.browserLiveCopySelection,
  // Comment in the agent's browser: the demo's computer has no real page.
  WS_METHODS.browserLiveEvaluate,
  WS_METHODS.browserLiveCapture,
]);

/** Cloud computers have the agent's browser; this Mac has none (its browser is the app's own). */
function hasLiveBrowser(machine: DemoMachine): boolean {
  return machine.machineKind === "uno_box";
}

/** The browser RPCs of a computer; `undefined` — not one of them. */
export function demoBrowserLiveUnary(
  machine: DemoMachine,
  body: NormalizedWsRpcRequestBody,
  emit: Emit,
): { readonly value: unknown } | undefined {
  if (!LIVE_METHODS.has(body._tag)) return undefined;
  emitters.set(machine.environmentId, emit);
  const state = liveStateFor(machine);
  switch (body._tag) {
    case WS_METHODS.browserLiveOpen: {
      const context = (body.context ?? {}) as { threadId?: string };
      const url = typeof body.url === "string" && body.url ? body.url : null;
      // The web version's own tab (YourBrowserTab): a page of its own, the person drives.
      if (typeof body.tab === "string" && body.tab) {
        const mine = state.pages.find((page) => page.tab === body.tab);
        if (mine) return { value: { pageId: mine.pageId } };
        const page: BrowserLivePage = {
          ...livePage(machine, `page-${state.pages.length + 1}`, "", url ?? "about:blank"),
          context: {},
          tab: body.tab,
          control: "human",
          title: "",
        };
        update(machine, { ...state, pages: [...state.pages, page] }, emit);
        return { value: { pageId: page.pageId } };
      }
      const threadId = context.threadId ?? "agent";
      const existing = state.pages.find((page) => page.context?.threadId === threadId);
      if (existing) {
        if (url) {
          update(
            machine,
            {
              ...state,
              pages: state.pages.map((page) =>
                page.pageId === existing.pageId
                  ? { ...page, url, attention: page.attention + 1 }
                  : page,
              ),
            },
            emit,
          );
        }
        return { value: { pageId: existing.pageId } };
      }
      const page = {
        ...livePage(
          machine,
          `page-${state.pages.length + 1}`,
          threadId,
          url ?? "https://landing-3flows.uno4.me/pricing",
        ),
        attention: 1,
      };
      update(machine, { ...state, pages: [...state.pages, page] }, emit);
      return { value: { pageId: page.pageId } };
    }
    case WS_METHODS.browserLiveSetControl: {
      const human = body.control === "human";
      const found = signIns.get(machine.environmentId);
      const signIn = found?.pageId === body.pageId ? found : undefined;
      // Handed back after signing in: the agent has its session and goes on.
      const signedIn = signIn !== undefined && !human && signIn.step === "done";
      const next = {
        ...state,
        pages: state.pages.map((page) =>
          page.pageId === body.pageId
            ? {
                ...page,
                control: human ? ("human" as const) : ("agent" as const),
                agentWaiting: human && page.help !== null,
                help: signedIn ? null : page.help,
              }
            : page,
        ),
      };
      if (signIn) {
        // Taking control puts the cursor in the first empty field, like a page does.
        signIn.focus = human ? firstEmptyField(signIn) : null;
        emitSignInFrame(machine.environmentId);
        if (signedIn) {
          const login = signIn.login;
          signIns.delete(machine.environmentId);
          setTimeout(() => demoSignIn.onSignedIn?.(login), 900);
        }
      }
      return { value: update(machine, next, emit) };
    }
    case WS_METHODS.browserLiveInput: {
      signInInput(machine, state, String(body.pageId), body.event as SignInInputEvent, emit);
      return { value: undefined };
    }
    case WS_METHODS.browserLiveSetup:
    case WS_METHODS.browserLiveSetProxy:
      return { value: state };
    case WS_METHODS.browserLiveCopySelection:
      return { value: { text: "" } };
    default:
      return { value: undefined };
  }
}

/** First values of the browser streams; `undefined` — not one of them. */
export function demoBrowserLiveInitial(
  machine: DemoMachine,
  request: NormalizedWsRpcRequestBody,
  emit: Emit,
): unknown[] | undefined {
  emitters.set(machine.environmentId, emit);
  if (request._tag === WS_METHODS.subscribeBrowserLive) {
    return hasLiveBrowser(machine) ? [liveStateFor(machine)] : [];
  }
  if (request._tag === WS_METHODS.subscribeBrowserLiveFrames) {
    if (typeof request.pageId !== "string") return [];
    const signIn = signIns.get(machine.environmentId);
    if (signIn?.pageId === request.pageId) {
      const frame = renderSignInFrame(signIn);
      return frame ? [frame] : [];
    }
    return frameData ? [{ pageId: request.pageId, data: frameData, width: 1280, height: 800 }] : [];
  }
  return undefined;
}

// ── Sign in for the agent (p2b) ──────────────────────────────────────────
//
// The agent of a chat hits github.com's sign-in in its browser and calls the
// person. The page is drawn here, live: a picture of the sign-in page with
// what the person types drawn into its fields (the password only as dots —
// its length is all this mock keeps, and only until the next step), then the
// 2FA page, then the repository signed in. Hand back after that, and the
// agent says so in the chat (`demoSignIn.onSignedIn`, set by show/p2b.ts).

type SignInStep = "login" | "2fa" | "done";
type SignInField = "login" | "password" | "code";

interface SignIn {
  readonly pageId: string;
  step: SignInStep;
  login: string;
  /** Only how many dots to draw: the password itself is never kept. */
  passwordLength: number;
  code: string;
  focus: SignInField | null;
}

type SignInInputEvent =
  | { readonly type: "mouse"; readonly action: string; readonly x: number; readonly y: number }
  | { readonly type: "key"; readonly action: string; readonly key: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: string };

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
interface SignInLayout {
  readonly fields: ReadonlyArray<Box & { readonly name: SignInField }>;
  readonly buttons: ReadonlyArray<Box & { readonly action: string }>;
  readonly slots: ReadonlyArray<Box & { readonly name: string }>;
}

const SIGN_IN_PAGES = {
  login: "github-login",
  "2fa": "github-2fa",
  done: "github-repo",
} as const satisfies Record<SignInStep, string>;
const SIGN_IN_URL: Record<SignInStep, string> = {
  login: "https://github.com/login?return_to=%2Fgetuno%2Flanding",
  "2fa": "https://github.com/sessions/two-factor/app",
  done: "https://github.com/getuno/landing",
};
const SIGN_IN_TITLE: Record<SignInStep, string> = {
  login: "Sign in to GitHub · GitHub",
  "2fa": "Two-factor authentication · GitHub",
  done: "getuno/landing",
};
/** The pages are drawn at 640×800 CSS px (2× pixels). */
const SIGN_IN_W = 640;
const SIGN_IN_H = 800;

const signIns = new Map<string, SignIn>();
const emitters = new Map<string, Emit>();
const signInImages = new Map<string, HTMLImageElement>();
let signInLayout: Record<string, SignInLayout> | null = null;

/** Hooks of the sign-in scene for the show function. */
export const demoSignIn: { onSignedIn?: (login: string) => void } = {};

async function loadSignInAssets(): Promise<void> {
  try {
    const response = await fetch(demoSiteUrl("agent/layout.json"));
    signInLayout = (await response.json()) as Record<string, SignInLayout>;
    await Promise.all(
      Object.values(SIGN_IN_PAGES).map(async (name) => {
        const image = new Image();
        image.src = demoSiteUrl(`agent/${name}.jpg`);
        await image.decode();
        signInImages.set(name, image);
      }),
    );
  } catch {
    signInLayout = null;
  }
}

function fieldsOf(signIn: SignIn) {
  return signInLayout?.[SIGN_IN_PAGES[signIn.step]]?.fields ?? [];
}

function fieldValue(signIn: SignIn, name: SignInField): string {
  if (name === "login") return signIn.login;
  if (name === "password") return "•".repeat(signIn.passwordLength);
  return signIn.code;
}

function firstEmptyField(signIn: SignIn): SignInField | null {
  const fields = fieldsOf(signIn);
  return (
    fields.find((field) => fieldValue(signIn, field.name) === "")?.name ?? fields[0]?.name ?? null
  );
}

const FONT = '-apple-system, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';

function renderSignInFrame(signIn: SignIn) {
  const name = SIGN_IN_PAGES[signIn.step];
  const image = signInImages.get(name);
  const layout = signInLayout?.[name];
  if (!image || !layout) return null;
  const canvas = document.createElement("canvas");
  canvas.width = SIGN_IN_W * 2;
  canvas.height = SIGN_IN_H * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(2, 2);
  ctx.drawImage(image, 0, 0, SIGN_IN_W, SIGN_IN_H);
  ctx.textBaseline = "middle";
  for (const field of layout.fields) {
    const value = fieldValue(signIn, field.name);
    const focused = signIn.focus === field.name;
    if (focused) {
      ctx.strokeStyle = "#0969da";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(field.x, field.y, field.w, field.h, 6);
      ctx.stroke();
    }
    ctx.fillStyle = "#1f2328";
    ctx.font = `${field.name === "password" ? 16 : 14}px ${FONT}`;
    const textX = field.x + 12;
    const textY = field.y + field.h / 2 + 0.5;
    ctx.fillText(value, textX, textY);
    if (focused) {
      const caretX = textX + ctx.measureText(value).width + 1;
      ctx.fillRect(caretX, field.y + 8, 1.2, field.h - 16);
    }
  }
  const user = layout.slots.find((slot) => slot.name === "user");
  if (user && signIn.login) {
    ctx.font = `13px ${FONT}`;
    ctx.fillStyle = "#59636e";
    ctx.textAlign = "right";
    ctx.fillText(`Signed in as ${signIn.login}`, user.x + user.w, user.y + user.h / 2);
  }
  const data = canvas.toDataURL("image/jpeg", 0.85).replace(/^data:image\/jpeg;base64,/, "");
  return { pageId: signIn.pageId, data, width: SIGN_IN_W, height: SIGN_IN_H };
}

function emitSignInFrame(environmentId: string) {
  const signIn = signIns.get(environmentId);
  const emit = emitters.get(environmentId);
  if (!signIn || !emit) return;
  const frame = renderSignInFrame(signIn);
  if (frame) setTimeout(() => emit(WS_METHODS.subscribeBrowserLiveFrames, frame), 10);
}

/** The page's address and title follow the step (the tab name and the card follow them). */
function setSignInPage(machine: DemoMachine, signIn: SignIn, emit: Emit) {
  const state = liveStateFor(machine);
  update(
    machine,
    {
      ...state,
      pages: state.pages.map((page) =>
        page.pageId === signIn.pageId
          ? { ...page, url: SIGN_IN_URL[signIn.step], title: SIGN_IN_TITLE[signIn.step] }
          : page,
      ),
    },
    emit,
  );
}

function submitSignIn(machine: DemoMachine, signIn: SignIn, emit: Emit) {
  if (signIn.step === "login") {
    if (!signIn.login.trim() || signIn.passwordLength === 0) {
      signIn.focus = firstEmptyField(signIn);
      return;
    }
    // The password went to the site; nothing of it stays here.
    signIn.passwordLength = 0;
    signIn.step = "2fa";
    signIn.focus = "code";
    setSignInPage(machine, signIn, emit);
    return;
  }
  if (signIn.step === "2fa" && signIn.code.length === 6) {
    signIn.step = "done";
    signIn.code = "";
    signIn.focus = null;
    setSignInPage(machine, signIn, emit);
  }
}

function typeInto(signIn: SignIn, text: string): boolean {
  const field = signIn.focus;
  if (!field) return false;
  for (const char of text) {
    if (field === "login") signIn.login = (signIn.login + char).slice(0, 39);
    else if (field === "password") signIn.passwordLength = Math.min(64, signIn.passwordLength + 1);
    else if (/\d/.test(char) && signIn.code.length < 6) signIn.code += char;
  }
  // GitHub sends the code by itself once it has six digits.
  return field === "code" && signIn.code.length === 6;
}

function signInInput(
  machine: DemoMachine,
  state: BrowserLiveState,
  pageId: string,
  event: SignInInputEvent,
  emit: Emit,
) {
  const signIn = signIns.get(machine.environmentId);
  const page = state.pages.find((candidate) => candidate.pageId === pageId);
  if (!signIn || signIn.pageId !== pageId || page?.control !== "human") return;
  let autoSubmit = false;
  if (event.type === "mouse" && "action" in event && event.action === "down" && "x" in event) {
    const layout = signInLayout?.[SIGN_IN_PAGES[signIn.step]];
    const inside = (box: Box) =>
      event.x >= box.x && event.x <= box.x + box.w && event.y >= box.y && event.y <= box.y + box.h;
    const field = layout?.fields.find(inside);
    if (field) signIn.focus = field.name;
    else if (layout?.buttons.some(inside)) submitSignIn(machine, signIn, emit);
    else signIn.focus = null;
  } else if (event.type === "key" && "key" in event && event.action === "down") {
    const key = event.key;
    if (key === "Enter") submitSignIn(machine, signIn, emit);
    else if (key === "Tab") {
      const fields = fieldsOf(signIn);
      const index = fields.findIndex((field) => field.name === signIn.focus);
      signIn.focus = fields[(index + 1) % Math.max(1, fields.length)]?.name ?? null;
    } else if (key === "Backspace") {
      if (signIn.focus === "login") signIn.login = signIn.login.slice(0, -1);
      else if (signIn.focus === "password")
        signIn.passwordLength = Math.max(0, signIn.passwordLength - 1);
      else if (signIn.focus === "code") signIn.code = signIn.code.slice(0, -1);
    } else if (key.length === 1) autoSubmit = typeInto(signIn, key);
    else return;
  } else if (event.type === "text" && "text" in event) {
    autoSubmit = typeInto(signIn, event.text);
  } else return;
  emitSignInFrame(machine.environmentId);
  if (autoSubmit) {
    setTimeout(() => {
      submitSignIn(machine, signIn, emit);
      emitSignInFrame(machine.environmentId);
    }, 450);
  }
}

/**
 * p2b: the chat's agent opened github.com in its browser, met the sign-in and
 * asks the person (`requestHelp`): the page's help and a bump of attention,
 * as the computer sends them — the app opens the tab and shows the cards.
 */
export function demoAgentNeedsSignIn(environmentId: string, threadId: string): void {
  const machine = machineByEnv(environmentId);
  if (!machine) return;
  const emit = emitters.get(machine.environmentId);
  if (!emit) return;
  const state = liveStateFor(machine);
  const existing = state.pages.find((page) => page.context?.threadId === threadId);
  const pageId = existing?.pageId ?? `page-signin-${threadId}`;
  const signIn: SignIn = {
    pageId,
    step: "login",
    login: "",
    passwordLength: 0,
    code: "",
    focus: null,
  };
  signIns.set(machine.environmentId, signIn);
  const base = existing ?? livePage(machine, pageId, threadId, SIGN_IN_URL.login);
  const page: BrowserLivePage = {
    ...base,
    url: SIGN_IN_URL.login,
    title: SIGN_IN_TITLE.login,
    control: "agent",
    help: { reason: "Sign in to github.com", requestedAt: new Date().toISOString() },
    attention: base.attention + 1,
    agentWaiting: false,
    width: SIGN_IN_W,
    height: SIGN_IN_H,
  };
  update(
    machine,
    {
      ...state,
      pages: existing
        ? state.pages.map((candidate) => (candidate.pageId === pageId ? page : candidate))
        : [...state.pages, page],
    },
    emit,
  );
  emitSignInFrame(machine.environmentId);
}

/** p2b again: the chat's page goes back to the pricing page the agent was on. */
export function demoSignInReset(environmentId: string, threadId: string): void {
  const machine = machineByEnv(environmentId);
  if (!machine) return;
  signIns.delete(machine.environmentId);
  const emit = emitters.get(machine.environmentId);
  const state = liveStateFor(machine);
  const existing = state.pages.find((page) => page.context?.threadId === threadId);
  if (!emit || !existing) return;
  const fresh = livePage(
    machine,
    existing.pageId,
    threadId,
    "https://landing-3flows.uno4.me/pricing",
  );
  update(
    machine,
    {
      ...state,
      pages: state.pages.map((page) =>
        page.pageId === existing.pageId ? { ...fresh, attention: page.attention } : page,
      ),
    },
    emit,
  );
  if (frameData) {
    const frame = { pageId: existing.pageId, data: frameData, width: 1280, height: 800 };
    setTimeout(() => emit(WS_METHODS.subscribeBrowserLiveFrames, frame), 10);
  }
}

// ── The test site's backend ──────────────────────────────────────────────

/** Before the catch-all `*\/api/*`: the order endpoint the test page calls answers 500. */
export const demoSiteHandlers = [
  http.post("*/api/order", async ({ request }) => {
    await delay(180);
    const body = (await request.json().catch(() => ({}))) as { plan?: string };
    return HttpResponse.json(
      {
        error: "internal_error",
        message: `Stripe price id is not set for plan "${body.plan ?? "team"}" (STRIPE_PRICE_TEAM is empty)`,
      },
      { status: 500, statusText: "Internal Server Error" },
    );
  }),
  http.get(
    "*/demo-site/img/*",
    () => new HttpResponse(null, { status: 404, statusText: "Not Found" }),
  ),
];

// Sites keep their real-looking addresses on screen and open the demo's pages.
demoHooks.siteOpenUrl = demoSiteOpenUrl;
