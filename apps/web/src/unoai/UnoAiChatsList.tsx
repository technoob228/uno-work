/**
 * The Uno AI chats (server-side — the same list as the console's /ask): in
 * lite's sidebar, and as a card on Home of the full app ("one history").
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { MessageSquareIcon, PlusIcon, SparklesIcon } from "lucide-react";

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../components/ui/sidebar";
import { listAiChats, unoAiAvailable, type AiChatSummary } from "./unoAiApi";
import { chatTitle } from "./unoAiModel";
import { unoAiKeys } from "./useUnoAiChat";

export const aiChatsQuery = () => ({
  queryKey: unoAiKeys.chats,
  queryFn: listAiChats,
  enabled: unoAiAvailable(),
  staleTime: 15_000,
  retry: false,
});

function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** Lite sidebar: "Uno" — a new chat and the recent chats. */
export function UnoAiSidebarGroup({ active }: { active: boolean }) {
  const chats = useQuery(aiChatsQuery());
  const search = useSearch({ strict: false }) as { chat?: string };
  const list = (chats.data?.chats ?? []).slice(0, 12);
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Uno</SidebarGroupLabel>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={active && !search.chat}
            render={<Link to="/ai" search={{}} data-testid="lite-nav-uno-new" />}
          >
            <PlusIcon />
            <span>New chat</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {list.map((c) => (
          <SidebarMenuItem key={c.id}>
            <SidebarMenuButton
              isActive={active && search.chat === c.id}
              render={<Link to="/ai" search={{ chat: c.id }} />}
              title={chatTitle(c.title)}
            >
              <MessageSquareIcon />
              <span className="truncate">{chatTitle(c.title)}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/**
 * Full app, Home: the Uno AI chats (made in the console or in Uno Work
 * without a computer). Hidden when there are none or the account isn't
 * reachable from here.
 */
export function UnoAiChatsCard() {
  const chats = useQuery(aiChatsQuery());
  const list: ReadonlyArray<AiChatSummary> = (chats.data?.chats ?? []).slice(0, 6);
  if (list.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="home-uno-ai-chats">
      <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <SparklesIcon className="size-3.5" />
        Uno AI chats
        <Link
          to="/ai"
          search={{}}
          className="ml-auto text-[11px] normal-case hover:text-foreground"
        >
          New chat
        </Link>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {list.map((c) => (
          <Link
            key={c.id}
            to="/ai"
            search={{ chat: c.id }}
            className="flex items-center gap-2.5 rounded-xl border border-border/70 px-3 py-2.5 text-sm transition-colors hover:border-foreground/25 hover:bg-muted/40"
          >
            <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{chatTitle(c.title)}</span>
            {c.sites && c.sites.length > 0 ? (
              <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-px text-[10px] text-emerald-700 dark:text-emerald-400">
                site
              </span>
            ) : null}
            <span className="shrink-0 text-[11px] text-muted-foreground">{ago(c.updated_at)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
