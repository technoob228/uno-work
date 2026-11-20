/**
 * Blocks layout (T55, demo 20.11): the sidebar as a list of blocks the person
 * arranges — built-in ones (Needs you, Pinned, Assistants, Chats…) and apps'
 * widgets. Kept free of React so the rules are tested directly.
 *
 * Rules:
 *   - `chats` is always there (a sidebar without the chat list has no way
 *     back to a chat) — it can move, never go away;
 *   - a block is once in a zone; unknown ids are dropped, except
 *     `widget:<computer>:<app>` — the app may simply be asleep right now;
 *   - system rows (a cloud chat asks to start a chat here, drafts, the
 *     setup row) are not blocks: they stay on top whatever the layout.
 */

export type Zone = "sidebar" | "home" | "panel";

export const BUILT_IN_BLOCKS = [
  "places",
  "assistants",
  "needs-you",
  "pinned",
  "chats",
  "projects",
  "computers",
  "apps",
] as const;
export type BuiltInBlockId = (typeof BUILT_IN_BLOCKS)[number];

/** `widget:<environment id>:<app id>` (each part URI-encoded) — an app's widget from one computer. */
export type WidgetBlockId = `widget:${string}`;
export type BlockId = BuiltInBlockId | WidgetBlockId;

export type BlockSize = "s" | "m" | "l";

export interface LayoutBlock {
  readonly id: BlockId;
  /** Widgets only: the frame's height in the sidebar. */
  readonly size?: BlockSize;
}

export type PresetId = "default" | "founder" | "developer" | "minimal";

export interface SidebarLayout {
  readonly blocks: ReadonlyArray<LayoutBlock>;
  /** The preset it started from; null once the person changed anything. */
  readonly preset: PresetId | null;
}

export const REQUIRED_BLOCK: BuiltInBlockId = "chats";

export function widgetBlockId(environmentId: string, appId: string): WidgetBlockId {
  return `widget:${encodeURIComponent(environmentId)}:${encodeURIComponent(appId)}`;
}

export function parseWidgetBlockId(
  id: string,
): { readonly environmentId: string; readonly appId: string } | null {
  const parts = id.split(":");
  if (parts.length !== 3 || parts[0] !== "widget" || !parts[1] || !parts[2]) return null;
  try {
    return { environmentId: decodeURIComponent(parts[1]), appId: decodeURIComponent(parts[2]) };
  } catch {
    return null;
  }
}

export function isBuiltInBlockId(value: unknown): value is BuiltInBlockId {
  return typeof value === "string" && (BUILT_IN_BLOCKS as ReadonlyArray<string>).includes(value);
}

export function isBlockId(value: unknown): value is BlockId {
  return (
    isBuiltInBlockId(value) || (typeof value === "string" && parseWidgetBlockId(value) !== null)
  );
}

/**
 * The presets. A widget in a preset names its app (`pult`), not a computer:
 * it is resolved against the apps the person has (`resolvePreset`), and left
 * out when there is no such app.
 */
export interface PresetSpec {
  readonly id: PresetId;
  readonly title: string;
  readonly hint: string;
  readonly blocks: ReadonlyArray<BuiltInBlockId | { readonly app: string; readonly size: BlockSize }>;
}

export const PRESETS: ReadonlyArray<PresetSpec> = [
  {
    id: "default",
    title: "Default",
    hint: "Places, assistants, pinned, chats",
    blocks: ["places", "assistants", "pinned", "chats"],
  },
  {
    id: "founder",
    title: "Founder",
    hint: "What waits for you and your dashboard on top",
    blocks: ["places", "needs-you", { app: "pult", size: "m" }, "pinned", "assistants", "chats"],
  },
  {
    id: "developer",
    title: "Developer",
    hint: "Computers and running apps next to the chats",
    blocks: ["places", "computers", "apps", "pinned", "chats"],
  },
  {
    id: "minimal",
    title: "Minimal",
    hint: "Just the chats",
    blocks: ["places", "chats"],
  },
];

export function presetSpec(id: PresetId): PresetSpec {
  return PRESETS.find((preset) => preset.id === id) ?? PRESETS[0]!;
}

/** A preset's blocks with its widgets bound to the person's apps (`appId` → computer). */
export function resolvePreset(
  id: PresetId,
  findApp: (app: string) => { readonly environmentId: string; readonly appId: string } | null,
): LayoutBlock[] {
  const out: LayoutBlock[] = [];
  for (const entry of presetSpec(id).blocks) {
    if (typeof entry === "string") {
      out.push({ id: entry });
      continue;
    }
    const found = findApp(entry.app);
    if (found) out.push({ id: widgetBlockId(found.environmentId, found.appId), size: entry.size });
  }
  return out;
}

export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = {
  blocks: presetSpec("default").blocks.map((id) => ({ id: id as BuiltInBlockId })),
  preset: "default",
};

/** A stored layout, cleaned: known ids once each, sizes only on widgets, chats always there. */
export function normalizeSidebarLayout(raw: unknown): SidebarLayout {
  if (!raw || typeof raw !== "object") return DEFAULT_SIDEBAR_LAYOUT;
  const record = raw as { blocks?: unknown; preset?: unknown };
  if (!Array.isArray(record.blocks)) return DEFAULT_SIDEBAR_LAYOUT;
  const seen = new Set<string>();
  const blocks: LayoutBlock[] = [];
  for (const item of record.blocks) {
    const id = item && typeof item === "object" ? (item as { id?: unknown }).id : item;
    if (!isBlockId(id) || seen.has(id)) continue;
    seen.add(id);
    const size = (item as { size?: unknown }).size;
    const widget = parseWidgetBlockId(id) !== null;
    blocks.push(
      widget ? { id, size: size === "s" || size === "l" ? size : "m" } : { id: id as BlockId },
    );
  }
  if (!seen.has(REQUIRED_BLOCK)) blocks.push({ id: REQUIRED_BLOCK });
  const preset = PRESETS.some((spec) => spec.id === record.preset)
    ? (record.preset as PresetId)
    : null;
  return { blocks, preset };
}

export type LayoutAction =
  | { readonly type: "add"; readonly id: BlockId; readonly size?: BlockSize; readonly at?: number }
  | { readonly type: "remove"; readonly id: BlockId }
  | { readonly type: "move"; readonly from: BlockId; readonly to: BlockId }
  | { readonly type: "resize"; readonly id: BlockId; readonly size: BlockSize }
  | { readonly type: "set"; readonly blocks: ReadonlyArray<LayoutBlock>; readonly preset: PresetId | null }
  | { readonly type: "reset" };

export function sidebarLayoutReducer(state: SidebarLayout, action: LayoutAction): SidebarLayout {
  switch (action.type) {
    case "add": {
      if (state.blocks.some((block) => block.id === action.id)) return state;
      const block: LayoutBlock =
        parseWidgetBlockId(action.id) !== null
          ? { id: action.id, size: action.size ?? "m" }
          : { id: action.id };
      const blocks = [...state.blocks];
      blocks.splice(action.at ?? blocks.length, 0, block);
      return { blocks, preset: null };
    }
    case "remove":
      if (action.id === REQUIRED_BLOCK) return state;
      return { blocks: state.blocks.filter((block) => block.id !== action.id), preset: null };
    case "move": {
      const from = state.blocks.findIndex((block) => block.id === action.from);
      const to = state.blocks.findIndex((block) => block.id === action.to);
      if (from === -1 || to === -1 || from === to) return state;
      const blocks = [...state.blocks];
      const [moved] = blocks.splice(from, 1);
      blocks.splice(to, 0, moved!);
      return { blocks, preset: null };
    }
    case "resize":
      return {
        blocks: state.blocks.map((block) =>
          block.id === action.id && block.size !== undefined
            ? { ...block, size: action.size }
            : block,
        ),
        preset: null,
      };
    case "set":
      return normalizeSidebarLayout({ blocks: action.blocks, preset: action.preset });
    case "reset":
      return DEFAULT_SIDEBAR_LAYOUT;
  }
}

/** Built-in blocks that aren't in the layout (the catalog's "Add"). */
export function addableBuiltIns(state: SidebarLayout): BuiltInBlockId[] {
  return BUILT_IN_BLOCKS.filter((id) => !state.blocks.some((block) => block.id === id));
}

/** Pixel height of a widget's frame in the sidebar. */
export function sidebarWidgetHeight(size: BlockSize | undefined): number {
  return size === "s" ? 112 : size === "l" ? 300 : 196;
}
