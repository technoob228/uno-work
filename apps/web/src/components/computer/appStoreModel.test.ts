import type { UnoComputerAppCategory, UnoComputerAppTemplate } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  ALL_TAB,
  applyStoreView,
  featuredTemplates,
  INSTALLED_TAB,
  NO_FILTERS,
  shelves,
  sortByRank,
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
    expect(view({ filters: { signInWithUno: true, fitsComputer: false } })).toEqual(["nextcloud"]);
    expect(
      view({ filters: { signInWithUno: false, fitsComputer: true }, memTotalMb: 1024 }),
    ).not.toContain("nextcloud");
  });
});
