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
import type { DemoMachine } from "./heavyFixtures";

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
  product: () => [
    app("pult", "Пульт", "🎛", "Agents, questions and reports", demoSiteUrl("apps/pult.html")),
  ],
  work: () => [
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
  const state = liveStateFor(machine);
  switch (body._tag) {
    case WS_METHODS.browserLiveOpen: {
      const context = (body.context ?? {}) as { threadId?: string };
      const url = typeof body.url === "string" && body.url ? body.url : null;
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
      const next = {
        ...state,
        pages: state.pages.map((page) =>
          page.pageId === body.pageId
            ? {
                ...page,
                control: body.control === "human" ? ("human" as const) : ("agent" as const),
              }
            : page,
        ),
      };
      return { value: update(machine, next, emit) };
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
): unknown[] | undefined {
  if (request._tag === WS_METHODS.subscribeBrowserLive) {
    return hasLiveBrowser(machine) ? [liveStateFor(machine)] : [];
  }
  if (request._tag === WS_METHODS.subscribeBrowserLiveFrames) {
    return frameData && typeof request.pageId === "string"
      ? [{ pageId: request.pageId, data: frameData, width: 1280, height: 800 }]
      : [];
  }
  return undefined;
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
