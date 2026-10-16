/**
 * Point 4 of the w0138 mock: tabs to look at. Three chats of the project
 * "landing" (two on the MacBook, one on uno-product) with their own tabs,
 * two files pinned to the project and the Pult app pinned everywhere.
 *
 * The real panel takes these as its starting state (PreviewPaneProvider asks
 * `demoHooks.previewInitialStates`); flipping the "Panel tabs" switch lays the
 * same tabs out the other way (B: everything belongs to the project).
 */
import { makePultFile } from "../components/preview/PreviewPaneContext";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  DEFAULT_PREVIEW_BUCKET_STATE,
  type PreviewBucketState,
} from "../components/preview/previewPanelState";
import type { PreviewFile, PreviewFileKind } from "../components/preview/PreviewPaneContext";
import {
  chatScopeKey,
  GLOBAL_SCOPE_KEY,
  projectScopeKey,
} from "../components/preview/previewTabScopes";
import { demoHooks, useDemoStore, type DemoSwitches } from "./demoFlag";
import { ENV_MAC, ENV_PRODUCT } from "./heavyFixtures";

/** Logical key of "landing": the same repository on the MacBook and uno-product. */
export const LANDING_PROJECT_KEY = "github.com/getuno/landing";
const MAC_ROOT = "/Users/misha/projects/landing";
const PRODUCT_ROOT = "/home/uno/projects/landing";

/** Chats of "landing" with tabs (thread ids of heavyFixtures). */
export const SEEDED_CHATS = {
  copy: "l-copy",
  hero: "l-hero",
  pricing: "s-pricing",
} as const;

function kindOf(name: string): PreviewFileKind {
  if (name.endsWith(".md")) return "md";
  if (name.endsWith(".png")) return "image";
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".docx")) return "docx";
  return "text";
}

function file(
  root: string,
  environmentId: EnvironmentId,
  relative: string,
  openedBy?: "agent",
): PreviewFile {
  const path = `${root}/${relative}`;
  const name = relative.split("/").pop() ?? relative;
  return {
    id: path,
    name,
    kind: kindOf(name),
    content: "",
    path,
    projectCwd: root,
    projectKey: LANDING_PROJECT_KEY,
    environmentId,
    ...(openedBy ? { openedBy } : {}),
  };
}

const mac = (relative: string, openedBy?: "agent") => file(MAC_ROOT, ENV_MAC, relative, openedBy);
const product = (relative: string, openedBy?: "agent") =>
  file(PRODUCT_ROOT, ENV_PRODUCT, relative, openedBy);

// Pult 4: the Pult is a real tab of Work now, not a static page.
const pultApp = (): PreviewFile => makePultFile();

const bucket = (files: ReadonlyArray<PreviewFile>): PreviewBucketState => ({
  ...DEFAULT_PREVIEW_BUCKET_STATE,
  files,
});

/** A chat's own view of the panel: open, with this tab in front. */
const view = (base: PreviewBucketState, activeFileId: string): PreviewBucketState => ({
  ...base,
  open: true,
  viewTouched: true,
  activeFileId,
});

export function seedPreviewStates(
  layout: DemoSwitches["tabs"],
): Record<string, PreviewBucketState> {
  const pinned = [mac("README.md"), mac("pricing.md")];
  const chats: Record<string, PreviewFile[]> = {
    [SEEDED_CHATS.copy]: [mac("hero.md", "agent"), mac("flow-2.md", "agent")],
    [SEEDED_CHATS.hero]: [mac("assets/hero-variants.png", "agent"), mac("brand-guide.pdf")],
    [SEEDED_CHATS.pricing]: [product("pricing-research.docx", "agent"), product("competitors.md")],
  };
  const active: Record<string, string> = {
    [SEEDED_CHATS.copy]: chats[SEEDED_CHATS.copy]![0]!.id,
    [SEEDED_CHATS.hero]: chats[SEEDED_CHATS.hero]![0]!.id,
    [SEEDED_CHATS.pricing]: chats[SEEDED_CHATS.pricing]![0]!.id,
  };
  const states: Record<string, PreviewBucketState> = {
    [GLOBAL_SCOPE_KEY]: bucket([pultApp()]),
  };
  if (layout === "project") {
    // B, like Codex: whatever was opened in any chat is a tab of the project;
    // each chat only remembers which tab it had in front.
    states[projectScopeKey(LANDING_PROJECT_KEY)] = bucket([
      ...pinned,
      ...Object.values(chats).flat(),
    ]);
    for (const [threadId, activeId] of Object.entries(active)) {
      states[chatScopeKey(threadId)] = view(DEFAULT_PREVIEW_BUCKET_STATE, activeId);
    }
    return states;
  }
  states[projectScopeKey(LANDING_PROJECT_KEY)] = bucket(pinned);
  for (const [threadId, files] of Object.entries(chats)) {
    states[chatScopeKey(threadId)] = view(bucket(files), active[threadId]!);
  }
  return states;
}

demoHooks.previewInitialStates = () => seedPreviewStates(useDemoStore.getState().switches.tabs);

// The switch lays the same tabs out the other way at once.
useDemoStore.subscribe((state, previous) => {
  if (state.switches.tabs === previous.switches.tabs) return;
  const set = demoHooks.setPreviewStates as
    | ((states: Record<string, PreviewBucketState>) => void)
    | undefined;
  set?.(seedPreviewStates(state.switches.tabs));
});
