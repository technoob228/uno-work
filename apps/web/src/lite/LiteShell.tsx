/**
 * The frame of web lite: a compact sidebar (My Uno's sections, what's free,
 * the step up to Uno Work in the cloud, sign out) around My Uno. None of the
 * full app's machinery runs here — no server state, no event router, no
 * WebSocket, no environment connections (see lite/webLite.ts).
 */
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import {
  BotIcon,
  CloudIcon,
  CreditCardIcon,
  DownloadIcon,
  GlobeIcon,
  LogOutIcon,
  ServerIcon,
  SparklesIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { planTitle } from "../account/billingModel";
import { balanceQuery, subscriptionQuery } from "../components/myuno/myUnoQueries";
import { Button } from "../components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "../components/ui/sidebar";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import type { MyUnoRouteSearch } from "../routes/_chat.my-uno";
import {
  LITE_HOME_PATH,
  liteLinks,
  liteRedirectPath,
  liteStanding,
  openCloudWork,
} from "./webLite";

/** The root of the lite app (rendered by routes/__root.tsx in the lite build). */
export function LiteRoot() {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <LiteShell>
          <Outlet />
        </LiteShell>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

/**
 * Anything outside My Uno that no route guard caught (an unknown path, an old
 * bookmark) goes to My Uno — once, not on every render.
 */
function useLiteHomeRedirect(): boolean {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const target = liteRedirectPath(pathname);
  const redirected = useRef<string | null>(null);
  useEffect(() => {
    if (!target || redirected.current === pathname) return;
    redirected.current = pathname;
    void navigate({ to: target, replace: true });
  }, [navigate, pathname, target]);
  return target !== null;
}

function LiteShell({ children }: { children: ReactNode }) {
  const leaving = useLiteHomeRedirect();
  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
      >
        <LiteSidebar />
      </Sidebar>
      {leaving ? null : children}
    </SidebarProvider>
  );
}

function LiteSidebar() {
  const search = useSearch({ strict: false }) as MyUnoRouteSearch;
  const subscription = useQuery(subscriptionQuery());
  const balance = useQuery(balanceQuery());
  const sub = subscription.data ?? null;
  const standing = subscription.isPending ? null : liteStanding(sub);
  const who = balance.data?.email ?? balance.data?.username ?? null;
  const plan = subscription.isPending ? null : sub ? planTitle(sub.limits, sub.plan) : "Free";

  const here = (tab: MyUnoRouteSearch["tab"], section: MyUnoRouteSearch["section"]) =>
    search.tab === tab && (tab === "billing" || search.section === section);

  const nav: ReadonlyArray<{
    label: string;
    icon: ReactNode;
    search: MyUnoRouteSearch;
    active: boolean;
  }> = [
    {
      label: "Computers",
      icon: <ServerIcon />,
      search: {},
      active: here(undefined, undefined),
    },
    {
      label: "Sites",
      icon: <GlobeIcon />,
      search: { section: "sites" },
      active: here(undefined, "sites"),
    },
    {
      label: "Cloud storage",
      icon: <CloudIcon />,
      search: { section: "cloud" },
      active: here(undefined, "cloud"),
    },
    {
      label: "Plan & billing",
      icon: <CreditCardIcon />,
      search: { tab: "billing" },
      active: here("billing", undefined),
    },
  ];

  const free: ReadonlyArray<{ label: string; icon: ReactNode; href: string; testId: string }> = [
    {
      label: "Download Uno Work",
      icon: <DownloadIcon />,
      href: liteLinks.download,
      testId: "lite-nav-download",
    },
    {
      label: "Connect your own AI",
      icon: <BotIcon />,
      href: liteLinks.connectAi,
      testId: "lite-nav-connect-ai",
    },
    {
      label: "Publish a website",
      icon: <GlobeIcon />,
      href: liteLinks.publishSite,
      testId: "lite-nav-publish",
    },
  ];

  return (
    <>
      <SidebarHeader className="px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <img src="/uno-mark.svg" alt="" className="size-5" />
          <span className="text-sm font-semibold">Uno Work</span>
          <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            in the browser
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>My Uno</SidebarGroupLabel>
          <SidebarMenu>
            {nav.map((item) => (
              <SidebarMenuItem key={item.label}>
                <SidebarMenuButton
                  isActive={item.active}
                  render={<Link to={LITE_HOME_PATH} search={item.search} />}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Free with Uno</SidebarGroupLabel>
          <SidebarMenu>
            {free.map((item) => (
              <SidebarMenuItem key={item.label}>
                <SidebarMenuButton
                  render={
                    <a
                      href={item.href}
                      target="_blank"
                      rel="noreferrer"
                      data-testid={item.testId}
                    />
                  }
                >
                  {item.icon}
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-3 p-3">
        {standing === "cloud" ? (
          <Button size="sm" onClick={openCloudWork} data-testid="lite-open-cloud">
            <SparklesIcon />
            Open Uno Work in the cloud
          </Button>
        ) : standing ? (
          <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-background/60 p-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Chats, agents and files on a computer that's always on — Uno Work in the cloud.
            </p>
            <Button
              size="sm"
              render={<a href={liteLinks.plus} target="_blank" rel="noreferrer" />}
              data-testid="lite-sidebar-plus"
            >
              <SparklesIcon />
              Get it — from Plus
            </Button>
          </div>
        ) : null}
        <div className="flex items-center gap-2 px-1">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium" title={who ?? undefined}>
              {who ?? " "}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">{plan ?? " "}</p>
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Sign out"
            title="Sign out"
            render={<a href={liteLinks.logout} data-testid="lite-sign-out" />}
          >
            <LogOutIcon />
          </Button>
        </div>
      </SidebarFooter>
    </>
  );
}
