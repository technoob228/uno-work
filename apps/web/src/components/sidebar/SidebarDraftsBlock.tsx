/**
 * Unsent work, above the chats: words left in another chat's box and messages
 * set aside with ⌘S (upstream `SidebarDraftBlock`). Nothing shows when there
 * is nothing unsent.
 */
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ArchiveIcon, SquarePenIcon, XIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import {
  DraftId,
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftThreadState,
} from "../../composerDraftStore";
import {
  restoreStashedMessage,
  stashedMessagePreview,
  useComposerStashStore,
} from "../../composerStashStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const MAX_DRAFT_ROWS = 5;

export interface UnsentDraft {
  readonly key: string;
  readonly preview: string;
  readonly open:
    | { readonly kind: "draft"; readonly draftId: string }
    | { readonly kind: "chat"; readonly ref: ScopedThreadRef };
}

/** Boxes with something typed, except the one on screen and drafts already on their way. */
export function unsentDrafts(input: {
  readonly drafts: Readonly<Record<string, ComposerThreadDraftState>>;
  readonly sessions: Readonly<Record<string, DraftThreadState>>;
  readonly onScreenKey: string | null;
}): UnsentDraft[] {
  return Object.entries(input.drafts).flatMap(([key, draft]): UnsentDraft[] => {
    if (key === input.onScreenKey) return [];
    const line = draft.prompt.trim().split("\n", 1)[0] ?? "";
    const pictures = Math.max(draft.images.length, draft.persistedAttachments.length);
    if (line.length === 0 && pictures === 0) return [];
    const preview = line || `${pictures} picture${pictures === 1 ? "" : "s"}`;
    const session = input.sessions[key];
    if (session) {
      if (session.promotedTo) return [];
      return [{ key, preview, open: { kind: "draft", draftId: key } }];
    }
    const ref = parseScopedThreadKey(key);
    return ref ? [{ key, preview, open: { kind: "chat", ref } }] : [];
  });
}

function DraftRow(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly title: string;
  readonly onOpen: () => void;
  readonly onDiscard: () => void;
}) {
  return (
    <li className="group/draft relative list-none">
      <button
        type="button"
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md pr-7 pl-2.5 text-left text-sidebar-muted-foreground text-sm hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        title={props.title}
        onClick={props.onOpen}
      >
        {props.icon}
        <span className="min-w-0 truncate">{props.label}</span>
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-1.5 right-1 opacity-0 group-hover/draft:opacity-100 focus-visible:opacity-100"
        aria-label={`Discard ${props.label}`}
        onClick={props.onDiscard}
      >
        <XIcon />
      </Button>
    </li>
  );
}

export function SidebarDraftsBlock() {
  const navigate = useNavigate();
  const route = useParams({ strict: false, select: (params) => resolveThreadRouteTarget(params) });
  const onScreenKey = route
    ? route.kind === "draft"
      ? route.draftId
      : scopedThreadKey(route.threadRef)
    : null;
  const drafts = useComposerDraftStore((store) => store.draftsByThreadKey);
  const sessions = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const stashed = useComposerStashStore((store) => store.entries);
  const removeStashed = useComposerStashStore((store) => store.remove);
  const unsent = useMemo(
    () => unsentDrafts({ drafts, sessions, onScreenKey }),
    [drafts, onScreenKey, sessions],
  );
  if (unsent.length === 0 && stashed.length === 0) return null;

  const openDraft = (draft: UnsentDraft) => {
    if (draft.open.kind === "draft") {
      void navigate({ to: "/draft/$draftId", params: { draftId: draft.open.draftId } });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(draft.open.ref),
    });
  };

  return (
    <section className="shrink-0 pb-1" data-testid="sidebar-drafts">
      <h3 className="px-2.5 pt-1 pb-0.5 text-[11px] text-sidebar-muted-foreground">Drafts</h3>
      <ul role="list" className="flex flex-col gap-px">
        {stashed.slice(0, MAX_DRAFT_ROWS).map((entry) => {
          const label = stashedMessagePreview(entry);
          return (
            <DraftRow
              key={entry.id}
              icon={<ArchiveIcon className="size-3.5 shrink-0" aria-hidden />}
              label={label}
              title="Set aside. Click to bring it into this chat"
              onOpen={() => {
                if (!restoreStashedMessage(entry.id)) {
                  toastManager.add({ type: "info", title: "Open a chat first" });
                }
              }}
              onDiscard={() => removeStashed(entry.id)}
            />
          );
        })}
        {unsent.slice(0, MAX_DRAFT_ROWS).map((draft) => (
          <DraftRow
            key={draft.key}
            icon={<SquarePenIcon className="size-3.5 shrink-0" aria-hidden />}
            label={draft.preview}
            title="Not sent yet. Click to open"
            onOpen={() => openDraft(draft)}
            onDiscard={() => {
              const target =
                draft.open.kind === "draft"
                  ? DraftId.make(draft.open.draftId)
                  : parseScopedThreadKey(draft.key);
              if (target) useComposerDraftStore.getState().clearComposerContent(target);
            }}
          />
        ))}
      </ul>
    </section>
  );
}
