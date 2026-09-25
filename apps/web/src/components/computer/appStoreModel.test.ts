import type { UnoComputerAppCategory, UnoComputerAppTemplate } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  ALL_TAB,
  applyStoreView,
  featuredTemplates,
  INSTALLED_TAB,
  hasFilters,
  logoSources,
  NO_FILTERS,
  phonePlatforms,
  shelves,
  sortByRank,
  storeHighlights,
} from "./appStoreModel";

function app(id: string, extra: Partial<UnoComputerAppTemplate> = {}): UnoComputerAppTemplate {
  return {
    id,
    name: id,
    description: `${id} app`,
    category: "files",
    icon: "",
    minRamMb: 512,
    minDiskGb: 2,
    settings: [],
    ...extra,
  };
}

const categories: UnoComputerAppCategory[] = [
  { id: "files", name: "Files & documents", technical: false },
  { id: "developer", name: "For developers", technical: true },
  { id: "ai", name: "AI", technical: false },
];

const catalog = [
  app("uptime-kuma", { category: "developer", rank: 910, featured: true }),
  app("nextcloud", {
    rank: 10,
    featured: true,
    keywords: ["google drive"],
    sso: "oidc",
    minRamMb: 2048,
  }),
  app("open-webui", { category: "ai", rank: 50, featured: true, tagline: "Your own ChatGPT" }),
  app("pingvin-share", { rank: 130 }),
];

describe("App Store storefront", () => {
  it("puts people's apps first and developer tools last", () => {
    expect(sortByRank(catalog).map((t) => t.id)).toEqual([
      "nextcloud",
      "open-webui",
      "pingvin-share",
      "uptime-kuma",
    ]);
    expect(shelves(catalog, categories).map((s) => s.id)).toEqual(["files", "ai", "developer"]);
  });

  it("never recommends a developer tool", () => {
    expect(featuredTemplates(catalog, categories).map((t) => t.id)).toEqual([
      "nextcloud",
      "open-webui",
    ]);
  });

  it("keeps an older console's order and shows its apps in one shelf", () => {
    const old = [app("uptime-kuma"), app("n8n")];
    expect(sortByRank(old).map((t) => t.id)).toEqual(["uptime-kuma", "n8n"]);
    expect(shelves(old, [])).toMatchObject([{ id: "_more", name: "Apps" }]);
  });

  const view = (over: Partial<Parameters<typeof applyStoreView>[0]>) =>
    applyStoreView({
      templates: catalog,
      tab: ALL_TAB,
      query: "",
      filters: NO_FILTERS,
      installed: new Set(),
      memTotalMb: null,
      ...over,
    }).map((t) => t.id);

  it("finds apps by what people call them", () => {
    expect(view({ query: "Google Drive" })).toEqual(["nextcloud"]);
    expect(view({ query: "chatgpt" })).toEqual(["open-webui"]);
    expect(view({ query: "nothing like this" })).toEqual([]);
  });

  it("filters by section, installed, Uno sign-in and memory", () => {
    expect(view({ tab: "ai" })).toEqual(["open-webui"]);
    expect(view({ tab: INSTALLED_TAB, installed: new Set(["pingvin-share"]) })).toEqual([
      "pingvin-share",
    ]);
    expect(view({ filters: { ...NO_FILTERS, signInWithUno: true } })).toEqual(["nextcloud"]);
    expect(
      view({ filters: { ...NO_FILTERS, fitsComputer: true }, memTotalMb: 1024 }),
    ).not.toContain("nextcloud");
  });
});

const mb = (n: number) => `${n / 1024} GB`;

describe("App Store v3", () => {
  const notetaker = app("notetaker", {
    category: "ai",
    rank: 70,
    madeByUno: true,
    ai: { chat: true, tasks: false, limitUsd: 10 },
    minRamMb: 2048,
  });
  const immich = app("immich", {
    rank: 60,
    minRamMb: 4096,
    mobile: {
      ios: "https://apps.apple.com/us/app/immich/id1613945652",
      android: "https://play.google.com/store/apps/details?id=app.alextran.immich",
      appName: null,
      note: "Enter your address.",
    },
  });
  const all = [...catalog, immich, notetaker];

  it("puts apps made by Uno first, everywhere", () => {
    expect(sortByRank(all)[0]?.id).toBe("notetaker");
    expect(featuredTemplates(all, categories).map((t) => t.id)).toEqual([
      "notetaker",
      "nextcloud",
      "open-webui",
    ]);
    // Recommended takes a Made by Uno app even when the console didn't feature it.
    const unfeatured = { ...notetaker, featured: false };
    expect(featuredTemplates([unfeatured], categories).map((t) => t.id)).toEqual(["notetaker"]);
  });

  it("filters apps with phone apps", () => {
    const filters = { ...NO_FILTERS, phoneApps: true };
    expect(hasFilters(filters)).toBe(true);
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(
      applyStoreView({
        templates: all,
        tab: ALL_TAB,
        query: "",
        filters,
        installed: new Set(),
        memTotalMb: null,
      }).map((t) => t.id),
    ).toEqual(["immich"]);
  });

  it("highlights what an app is like, Made by Uno first", () => {
    expect(storeHighlights(notetaker, true, mb).map((h) => h.label)).toEqual([
      "Made by Uno",
      "Uses AI",
      "2 GB+",
    ]);
    expect(storeHighlights(immich, false, mb)).toEqual([
      { kind: "phone", label: "Phone apps", ios: true, android: true },
      { kind: "memory", label: "Needs 4 GB", tight: true },
    ]);
    expect(storeHighlights(app("tiny", { minRamMb: 0 }), null, mb)).toEqual([]);
    expect(phonePlatforms(immich.mobile!)).toBe("iOS and Android");
    expect(phonePlatforms({ ...immich.mobile!, ios: null })).toBe("Android");
  });

  it("falls back to the console's logo by id when the computer passes none or it fails", () => {
    expect(
      logoSources({ id: "memos", iconUrl: "https://x/api/v1/apps/icons/memos.png" }, "https://c"),
    ).toEqual([
      "https://x/api/v1/apps/icons/memos.png",
      "https://c/api/v1/apps/icons/memos.svg",
      "https://c/api/v1/apps/icons/memos.png",
    ]);
    // The console's own address is not tried twice.
    expect(
      logoSources({ id: "memos", iconUrl: "https://c/api/v1/apps/icons/memos.png" }, "https://c"),
    ).toEqual(["https://c/api/v1/apps/icons/memos.png", "https://c/api/v1/apps/icons/memos.svg"]);
    expect(logoSources({ id: "memos", iconUrl: null }, "https://c")).toEqual([
      "https://c/api/v1/apps/icons/memos.svg",
      "https://c/api/v1/apps/icons/memos.png",
    ]);
    expect(logoSources({ id: "../x", iconUrl: undefined })).toEqual([]);
  });
});
