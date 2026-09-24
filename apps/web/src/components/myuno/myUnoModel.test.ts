import { describe, expect, it } from "vitest";

import {
  type AccountComputer,
  type AccountSubscription,
  type ComputerApp,
  parseAccountComputer,
  parseSubscription,
} from "../../account/accountOverview";
import {
  appHealth,
  bringBackAction,
  type ComputerEntry,
  computerEntry,
  filterCounts,
  groupEntries,
  groupShare,
  hasProblem,
  localEntry,
  matchesQuery,
  matchesSite,
  planRunning,
  rowAction,
  sortEntries,
  stateLabel,
  worthALook,
} from "./myUnoModel";

function box(raw: Record<string, unknown>): AccountComputer {
  const parsed = parseAccountComputer({ ram_mb: 2048, vcpu: 1, disk_gb: 10, ...raw });
  if (!parsed) throw new Error("bad fixture");
  return parsed;
}

function app(id: number, name: string, status = "success", url?: string): ComputerApp {
  return { id, name, icon: "", status, url: url ?? null };
}

const work = (id: number, name: string, status = "running") =>
  box({ id, name, status, work_machine: true });
const server = (id: number, name: string, role: string, status = "running") =>
  box({ id, name, status, computer_role: role });

describe("appHealth", () => {
  it("reads the console's deployment status and the mock's words", () => {
    expect(appHealth("success")).toBe("running");
    expect(appHealth("running")).toBe("running");
    expect(appHealth("failed")).toBe("failed");
    expect(appHealth("building")).toBe("installing");
    expect(appHealth("queued")).toBe("installing");
    expect(appHealth("cancelled")).toBe("stopped");
  });
});

describe("computer rows", () => {
  it("names what the row's one button does", () => {
    const here = computerEntry(work(1, "desk"), [], true);
    const other = computerEntry(work(2, "lab"), [], false);
    const sleeping = computerEntry(work(3, "night", "sleeping"), [], false);
    const stopped = computerEntry(server(4, "bot", "server", "stopped"), [], false);
    const archived = computerEntry(server(5, "old", "server", "archived"), [], false);
    const running = computerEntry(server(6, "vpn", "server"), [], false);
    const broken = computerEntry(work(7, "stuck", "error"), [], false);
    const starting = computerEntry(work(8, "boot", "starting"), [], false);
    expect(rowAction(here)).toBe("here");
    expect(rowAction(other)).toBe("open");
    expect(rowAction(sleeping)).toBe("wake");
    expect(rowAction(stopped)).toBe("wake");
    expect(rowAction(archived)).toBe("none");
    // A server is checked, not opened.
    expect(rowAction(running)).toBe("none");
    expect(rowAction(broken)).toBe("none");
    expect(rowAction(starting)).toBe("none");
    expect(rowAction(localEntry("This Mac", false))).toBe("open");
    expect(rowAction(localEntry("This Mac", true))).toBe("here");
  });

  it("wakes a sleeping computer and starts a stopped one", () => {
    expect(bringBackAction("sleeping")).toBe("wake");
    expect(bringBackAction("paused_ram")).toBe("wake");
    expect(bringBackAction("stopped")).toBe("start");
    expect(bringBackAction("suspended")).toBe("start");
    expect(bringBackAction("archived")).toBeNull();
    expect(bringBackAction("running")).toBeNull();
  });

  it("says a broken computer isn't responding", () => {
    expect(stateLabel(computerEntry(work(1, "a", "error"), [], false))).toBe("Not responding");
    expect(stateLabel(computerEntry(work(1, "a", "sleeping"), [], false))).toBe("Asleep");
    expect(stateLabel(computerEntry(work(1, "a", "stopping"), [], false))).toBe("Going to sleep…");
  });

  it("collects addresses from the computer and its apps, once each", () => {
    const entry = computerEntry(
      box({ id: 9, name: "srv", status: "running", url: "https://srv.uno4.dev/" }),
      [
        app(1, "n8n", "success", "https://n8n-9.app.uno4.dev"),
        app(2, "Memos", "success", "https://srv.uno4.dev/memos"),
      ],
      false,
    );
    expect(entry.addresses).toEqual(["srv.uno4.dev", "n8n-9.app.uno4.dev"]);
  });
});

describe("search and filters", () => {
  const entries: ComputerEntry[] = [
    computerEntry(work(1, "desk"), [app(1, "Memos")], true),
    computerEntry(work(2, "night-owl", "sleeping"), [], false),
    computerEntry(
      server(3, "outreach-machine", "production"),
      [app(2, "WireGuard VPN", "success", "https://vpn.caba.example.com")],
      false,
    ),
    computerEntry(server(4, "old-experiment", "sandbox", "error"), [], false),
    localEntry("This Mac", false),
  ];

  it("finds a computer by name, app, address, role and note", () => {
    const names = (q: string) => entries.filter((e) => matchesQuery(e, q)).map((e) => e.name);
    expect(names("memos")).toEqual(["desk"]);
    expect(names("wireguard")).toEqual(["outreach-machine"]);
    expect(names("caba.example")).toEqual(["outreach-machine"]);
    expect(names("production")).toEqual(["outreach-machine"]);
    expect(names("uno work")).toEqual(["desk", "night-owl", "This Mac"]);
    expect(names("  ")).toHaveLength(5);
    expect(names("nothing-like-this")).toEqual([]);
  });

  it("counts and groups: Uno Work first (here, this Mac, awake, asleep), servers broken first", () => {
    expect(filterCounts(entries)).toEqual({ all: 5, work: 3, servers: 2, asleep: 1 });
    const all = groupEntries(entries, "all", "");
    expect(all.work.map((e) => e.name)).toEqual(["desk", "This Mac", "night-owl"]);
    expect(all.servers.map((e) => e.name)).toEqual(["old-experiment", "outreach-machine"]);
    expect(groupEntries(entries, "asleep", "").work.map((e) => e.name)).toEqual(["night-owl"]);
    expect(groupEntries(entries, "servers", "").work).toEqual([]);
    expect(groupEntries(entries, "work", "memos").work.map((e) => e.name)).toEqual(["desk"]);
  });

  it("orders servers by role when none is broken", () => {
    const sorted = sortEntries([
      computerEntry(server(1, "a-sandbox", "sandbox"), [], false),
      computerEntry(server(2, "b-staging", "staging"), [], false),
      computerEntry(server(3, "c-prod", "production"), [], false),
      computerEntry(server(4, "d-server", "server"), [], false),
    ]);
    expect(sorted.map((e) => e.name)).toEqual(["c-prod", "d-server", "b-staging", "a-sandbox"]);
  });

  it("finds a site by name, address and own domain", () => {
    const site = {
      slug: "landing",
      url: "https://caba.example.com",
      customDomain: "caba.example.com",
    };
    expect(matchesSite(site, "LAND")).toBe(true);
    expect(matchesSite(site, "caba")).toBe(true);
    expect(matchesSite(site, "wedding")).toBe(false);
  });
});

describe("worth a look", () => {
  it("lists broken computers and apps that didn't install — and nothing else", () => {
    const entries = [
      computerEntry(work(1, "desk"), [app(1, "Memos")], true),
      computerEntry(server(2, "shop", "production"), [app(2, "Plausible", "failed")], false),
      computerEntry(server(3, "old", "sandbox", "error"), [], false),
      computerEntry(work(4, "sleepy", "sleeping"), [], false),
      localEntry("This Mac", true),
    ];
    const items = worthALook(entries);
    expect(items.map((item) => item.key)).toEqual(["computer-box-3", "app-box-2-2"]);
    expect(hasProblem(entries[1]!)).toBe(true);
    expect(hasProblem(entries[0]!)).toBe(false);
  });

  it("is empty when everything runs", () => {
    expect(worthALook([computerEntry(work(1, "desk"), [app(1, "Memos")], true)])).toEqual([]);
  });
});

describe("plan", () => {
  const subscription = parseSubscription({
    plan: "pro-v2",
    price_usd: 70,
    plan_limits: {
      slug: "pro-v2",
      name: "Pro",
      price_usd: 70,
      compute_price_usd: 70,
      max_box: { ram_mb: 16384, vcpu: 8 },
      peak: { ram_mb: 16384, vcpu: 8 },
    },
    usage: { running_ram_mb: 6144, running_vcpu: 3 },
  }) as AccountSubscription;

  it("shows how much of the plan runs now", () => {
    expect(planRunning(subscription)).toEqual({
      usedRamMb: 6144,
      peakRamMb: 16384,
      freeRamMb: 10240,
      pct: 38,
    });
    expect(planRunning(null)).toBeNull();
  });

  it("adds up what a group costs out of the plan; this Mac is free", () => {
    const entries = [
      computerEntry(work(1, "a"), [], false),
      computerEntry(box({ id: 2, name: "b", status: "running", ram_mb: 4096 }), [], false),
      localEntry("This Mac", false),
    ];
    // 2 GB and 4 GB of a 16 GB, $70 plan.
    expect(groupShare(entries, subscription)).toBe(26.25);
    expect(groupShare([localEntry("This Mac", false)], subscription)).toBeNull();
    expect(groupShare(entries, null)).toBeNull();
  });
});
