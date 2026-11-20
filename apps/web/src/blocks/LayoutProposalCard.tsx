/**
 * An agent proposes a sidebar (T55 demo): the `sidebar_layout_propose` tool
 * of the uno-work MCP answers with the blocks; the chat shows them as a card
 * and nothing changes until the person presses Apply. Undo brings the old
 * sidebar back (also from the note on top of the sidebar).
 *
 * The agent only arranges blocks that exist — built-in ones and widgets of
 * apps on the person's computers; a new widget it has to make as an app first.
 */
import { CheckIcon, LayoutPanelLeftIcon, PencilIcon, Undo2Icon } from "lucide-react";

import { cn } from "../lib/utils";
import { BUILT_IN_INFO, useWidgetApps, widgetAppOf } from "./catalog";
import {
  isBuiltInBlockId,
  normalizeSidebarLayout,
  type LayoutBlock,
  type SidebarLayout,
} from "./layoutModel";
import { useSidebarLayoutStore } from "./layoutStore";

export interface LayoutProposal {
  readonly title: string;
  readonly why: string | null;
  readonly layout: SidebarLayout;
}

/** The proposal in a `sidebar_layout_propose` result, or null. */
export function layoutProposalFromToolResult(raw: string | undefined): LayoutProposal | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.trim()) as {
      proposal?: { title?: unknown; why?: unknown; blocks?: unknown };
    };
    const proposal = parsed.proposal;
    if (!proposal || !Array.isArray(proposal.blocks)) return null;
    return {
      title: typeof proposal.title === "string" ? proposal.title : "Sidebar",
      why: typeof proposal.why === "string" ? proposal.why : null,
      layout: normalizeSidebarLayout({ blocks: proposal.blocks, preset: null }),
    };
  } catch {
    return null;
  }
}

function sameLayout(a: SidebarLayout, b: SidebarLayout): boolean {
  return (
    a.blocks.length === b.blocks.length &&
    a.blocks.every((block, index) => block.id === b.blocks[index]?.id)
  );
}

export function LayoutProposalCard(props: { proposal: LayoutProposal; agent: string }) {
  const current = useSidebarLayoutStore((state) => state.layout);
  const replace = useSidebarLayoutStore((state) => state.replace);
  const undo = useSidebarLayoutStore((state) => state.undo);
  const undoReplace = useSidebarLayoutStore((state) => state.undoReplace);
  const setEditing = useSidebarLayoutStore((state) => state.setEditing);
  const apps = useWidgetApps();
  const applied = sameLayout(current, props.proposal.layout);
  const name = (block: LayoutBlock) => {
    if (isBuiltInBlockId(block.id)) return BUILT_IN_INFO[block.id];
    const item = widgetAppOf(apps, block.id);
    return {
      title: item ? (item.app.widget?.title ?? item.app.name) : "App widget",
      hint: item ? `Widget of ${item.app.name} · ${item.computer}` : "",
      icon: <span className="text-[13px] leading-none">{item?.app.icon ?? "▢"}</span>,
    };
  };
  return (
    <div
      className="my-2 max-w-md overflow-hidden rounded-xl border border-border bg-card shadow-xs"
      data-testid="layout-proposal-card"
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2.5">
        <LayoutPanelLeftIcon className="size-4 text-primary" />
        <span className="flex-1 text-[13px] font-semibold">{props.proposal.title}</span>
        <span className="text-[11px] text-muted-foreground">
          {props.proposal.layout.blocks.length} blocks
        </span>
      </div>
      <ol className="space-y-1 px-3.5 py-2.5">
        {props.proposal.layout.blocks.map((block, index) => {
          const info = name(block);
          const isNew = !current.blocks.some((item) => item.id === block.id);
          return (
            <li key={block.id} className="flex items-center gap-2 text-[13px]">
              <span className="w-4 text-right text-[11px] text-muted-foreground/70">
                {index + 1}
              </span>
              <span className="inline-flex size-6 items-center justify-center rounded-md bg-muted text-foreground/75 [&_svg]:size-3.5">
                {info.icon}
              </span>
              <span className="font-medium">{info.title}</span>
              {block.size ? (
                <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground uppercase">
                  {block.size}
                </span>
              ) : null}
              {isNew && !applied ? (
                <span className="rounded-full bg-primary/12 px-1.5 text-[10px] font-medium text-primary">
                  new
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {props.proposal.why ? (
        <p className="px-3.5 pb-2.5 text-xs leading-snug text-muted-foreground">
          {props.proposal.why}
        </p>
      ) : null}
      <div className="flex items-center gap-2 border-t border-border/70 bg-muted/30 px-3.5 py-2">
        {applied ? (
          <>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
              <CheckIcon className="size-3.5" />
              Applied to your sidebar
            </span>
            <span className="flex-1" />
            {undo ? (
              <button
                type="button"
                onClick={undoReplace}
                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Undo2Icon className="size-3.5" />
                Undo
              </button>
            ) : null}
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => replace(props.proposal.layout, { kind: "agent", label: props.agent })}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90",
              )}
              data-testid="layout-proposal-apply"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={() => {
                replace(props.proposal.layout, { kind: "agent", label: props.agent });
                setEditing(true);
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs hover:border-primary/50"
            >
              <PencilIcon className="size-3" />
              Apply and adjust
            </button>
            <span className="flex-1" />
            <span className="text-[11px] text-muted-foreground">Nothing changes until you apply</span>
          </>
        )}
      </div>
    </div>
  );
}
