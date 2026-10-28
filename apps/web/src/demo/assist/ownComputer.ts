/**
 * Assistants D, edit 1: "A computer of its own" in the wizard, answered by
 * the made-up Uno account — so the real `OwnComputerSetup` runs the real
 * create job (`account/unoAccount.ts` → `/_account/*`) and pairs with a real
 * (in-page) daemon.
 *
 * Two worlds, by the plan (`tier=`):
 *   plus — room for one more 4 GB computer: launch → provisioning → running
 *          (~1 s), port 80, a pairing link to `own.demo.uno4.me`, whose daemon
 *          (`MACHINES.own`) answers from then on;
 *   free — the plan's computers go up to 2 GB: the wizard shows "Needs an
 *          upgrade" before the button, and a launch anyway answers
 *          409 SHAPE_TOO_LARGE as the console does.
 */
import { HttpResponse, http, type HttpHandler } from "msw";

import { MACHINES } from "../heavyFixtures";
import { WORLD } from "./world";

interface OwnBox {
  readonly id: number;
  readonly name: string;
  status: "provisioning" | "running";
  readonly createdAt: string;
}

let own: OwnBox | null = null;

/** The wizard made the assistant's computer and it is on (its daemon answers). */
export function ownComputerRunning(): boolean {
  return own?.status === "running";
}

const MB = 1024;

function wireOwn(box: OwnBox) {
  return {
    id: box.id,
    name: box.name,
    status: box.status,
    os: "Ubuntu 24.04",
    ram_mb: 4 * MB,
    vcpu: 2,
    disk_gb: 20,
    created_at: box.createdAt,
    hostname: MACHINES.own.host,
    url: `https://${MACHINES.own.host}`,
    work_machine: true,
    computer_role: "assistant",
  };
}

/** The account's computers with the assistant's one added (daemon.ts lists the rest). */
export function withOwnComputer<T>(boxes: T[]): Array<T | ReturnType<typeof wireOwn>> {
  return own ? [...boxes, wireOwn(own)] : boxes;
}

const PLANS = {
  free: {
    slug: "free",
    name: "Free",
    price_usd: 0,
    max_box: { ram_mb: 2 * MB, vcpu: 1 },
    peak: { ram_mb: 2 * MB, vcpu: 1 },
    disk_gb: 20,
    cloud_work: false,
  },
  small: {
    slug: "small",
    name: "Small",
    price_usd: 10,
    max_box: { ram_mb: 2 * MB, vcpu: 1 },
    peak: { ram_mb: 4 * MB, vcpu: 2 },
    disk_gb: 40,
    cloud_work: false,
  },
  plus: {
    slug: "plus",
    name: "Plus",
    price_usd: 20,
    max_box: { ram_mb: 16 * MB, vcpu: 8 },
    peak: { ram_mb: 32 * MB, vcpu: 16 },
    disk_gb: 400,
    cloud_work: true,
  },
  pro: {
    slug: "pro",
    name: "Pro",
    price_usd: 69,
    max_box: { ram_mb: 32 * MB, vcpu: 16 },
    peak: { ram_mb: 64 * MB, vcpu: 32 },
    disk_gb: 800,
    cloud_work: true,
  },
} as const;

function subscription() {
  const plus = WORLD.tier === "plus";
  const extra = own ? { ram: own.status === "running" ? 4 * MB : 0, disk: 20, boxes: 1 } : null;
  return {
    plan: plus ? "plus" : "free",
    status: "active",
    price_usd: plus ? 20 : 0,
    ...(plus ? { renews_at: new Date(Date.now() + 86_400_000 * 12).toISOString() } : {}),
    plan_limits: plus ? PLANS.plus : PLANS.free,
    usage: {
      running_ram_mb: (plus ? 16 * MB : 0) + (extra?.ram ?? 0),
      running_vcpu: plus ? 8 : 0,
      disk_gb_used: (plus ? 160 : 20) + (extra?.disk ?? 0),
      box_count: (WORLD.account === "live" ? 2 : 1) + (extra?.boxes ?? 0),
    },
  };
}

export function ownComputerHandlers(): HttpHandler[] {
  const isOwn = (id: unknown) => own !== null && String(id) === String(own.id);
  return [
    http.get("*/_account/api/v1/box-subscription", () => HttpResponse.json(subscription())),
    http.get("*/_account/api/v1/work/plans", () =>
      HttpResponse.json({ plans: [PLANS.small, PLANS.plus, PLANS.pro], plans_v2: false }),
    ),
    http.get("*/_account/api/v1/work/image", () =>
      HttpResponse.json({ image_id: 258, name: "uno-work", state: "ready" }),
    ),
    http.post("*/_account/api/v1/images/:id/launch", async ({ request }) => {
      if (WORLD.tier !== "plus") {
        return HttpResponse.json({ error: "SHAPE_TOO_LARGE" }, { status: 409 });
      }
      if (own) return HttpResponse.json({ error: "ASSISTANT_LIMIT" }, { status: 409 });
      const body = (await request.json().catch(() => ({}))) as { name?: string };
      own = {
        id: MACHINES.own.boxId!,
        name: body.name || "assistant-computer",
        status: "provisioning",
        createdAt: new Date().toISOString(),
      };
      const made = own;
      setTimeout(() => {
        made.status = "running";
      }, 1_000);
      return HttpResponse.json(wireOwn(made), { status: 201 });
    }),
    http.get("*/_account/api/v1/boxes/:id", ({ params }) =>
      isOwn(params.id) ? HttpResponse.json(wireOwn(own!)) : undefined,
    ),
    http.get("*/_account/api/v1/boxes/:id/ports", ({ params }) =>
      isOwn(params.id) ? HttpResponse.json({ ports: [] }) : undefined,
    ),
    http.post("*/_account/api/v1/boxes/:id/ports", ({ params }) =>
      isOwn(params.id)
        ? HttpResponse.json({ internal_port: 80, external_port: 443 }, { status: 201 })
        : undefined,
    ),
    http.post("*/_account/api/v1/boxes/:id/work/session", ({ params }) => {
      if (!isOwn(params.id)) return undefined;
      if (own!.status !== "running") {
        return HttpResponse.json({ error: "WORK_MACHINE_STARTING" }, { status: 409 });
      }
      return HttpResponse.json({
        url: `https://${MACHINES.own.host}/pair#token=demo-own`,
        hostname: MACHINES.own.host,
        expires_at: new Date(Date.now() + 120_000).toISOString(),
      });
    }),
    // Pairing with a computer's daemon (the MacBook was saved with a token already).
    http.post("*/api/auth/bootstrap/bearer", () =>
      HttpResponse.json({
        authenticated: true,
        role: "owner",
        sessionMethod: "bearer-session-token",
        expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
        sessionToken: "demo-bearer",
      }),
    ),
  ];
}
