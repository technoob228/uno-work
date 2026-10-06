/**
 * The frame of web lite: the full app's sidebar D, minus what needs a
 * computer — the account button and New chat on top, the chats below, and
 * everything else (My Uno's sections, the free extras, the console, sign out)
 * in the account menu. No upsell in the sidebar: the chat offers a computer
 * when a task needs one (Miha 05.10: "why should the free version look
 * different?"). None of the full app's machinery runs here — no server
 * state, no event router, no WebSocket, no environment connections (see
 * lite/webLite.ts).
 */
import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BotIcon,
  CircleHelpIcon,
  CloudIcon,
  CreditCardIcon,
  DownloadIcon,
  GlobeIcon,
  LogOutIcon,
  PanelLeftCloseIcon,
  ServerIcon,
  SparklesIcon,
  SquarePenIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { CONSOLE_URL } from "../account/accountOverview";
import { planTitle } from "../account/billingModel";
import { balanceQuery, subscriptionQuery } from "../components/myuno/myUnoQueries";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "../components/ui/menu";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarProvider,
  useSidebar,
} from "../components/ui/sidebar";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import type { MyUnoRouteSearch } from "../routes/_chat.my-uno";
import {
  LITE_AI_PATH,
  LITE_HOME_PATH,
  liteLinks,
  liteRedirectHref,
  liteStanding,
  openCloudWork,
} from "./webLite";
import {
  SidebarDAccountTrigger,
  SidebarDHeaderIcon,
  openExternal,
} from "../components/sidebar/SidebarDAccountButton";
import { SidebarShortcutListener } from "../components/sidebar/SidebarShowButton";
import { PaymentNoticeBanner } from "../components/billing/PaymentNoticeBanner";
import { UnoAiSidebarChats } from "../unoai/UnoAiChatsList";
import { LiveBotTile } from "../unoai/BotCard";
import { WORK_AI_FEATURE } from "../unoai/unoAiApi";

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
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const navigate = useNavigate();
  const target = liteRedirectHref(pathname, searchStr);
  const redirected = useRef<string | null>(null);
  useEffect(() => {
    if (!target || redirected.current === pathname) return;
    redirected.current = pathname;
    void navigate({ href: target, replace: true });
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
      <SidebarShortcutListener />
      <PaymentNoticeBanner />
    </SidebarProvider>
  );
}

/** The name on the account button: lite has no computer, so it's the app's. */
const LITE_ACCOUNT_LABEL = "Uno Work";

/**
 * The account menu of lite — the same button as the full app's, holding what
 * the lite sidebar used to list: My Uno's sections, the free extras, the
 * console and sign out.
 */
export function LiteAccountMenu() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const subscription = useQuery(subscriptionQuery());
  const balance = useQuery(balanceQuery());
  const sub = subscription.data ?? null;
  const standing = subscription.isPending ? null : liteStanding(sub);
  const who = balance.data?.email ?? balance.data?.username ?? null;
  const plan = subscription.isPending ? null : sub ? planTitle(sub.limits, sub.plan) : "Free";
  const go = (search: MyUnoRouteSearch) => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: LITE_HOME_PATH, search });
  };
  const myUno: ReadonlyArray<{ label: string; icon: ReactNode; search: MyUnoRouteSearch }> = [
    { label: "Plan & billing", icon: <CreditCardIcon />, search: { tab: "billing" } },
    { label: "Computers", icon: <ServerIcon />, search: {} },
    { label: "Sites", icon: <GlobeIcon />, search: { section: "sites" } },
    { label: "Cloud storage", icon: <CloudIcon />, search: { section: "cloud" } },
  ];
  const external: ReadonlyArray<{ label: string; icon: ReactNode; href: string; testId: string }> =
    [
      {
        label: "Download Uno Work",
        icon: <DownloadIcon />,
        href: liteLinks.download,
        testId: "lite-menu-download",
      },
      {
        label: "Connect your own AI",
        icon: <BotIcon />,
        href: liteLinks.connectAi,
        testId: "lite-menu-connect-ai",
      },
      {
        label: "Uno console",
        icon: <ArrowUpRightIcon />,
        href: CONSOLE_URL,
        testId: "lite-menu-console",
      },
      {
        label: "Help",
        icon: <CircleHelpIcon />,
        href: `${CONSOLE_URL}/docs`,
        testId: "lite-menu-help",
      },
    ];
  return (
    <Menu>
      <SidebarDAccountTrigger label={LITE_ACCOUNT_LABEL} who={who} variant="header" />
      <MenuPopup
        align="start"
        side="bottom"
        className="min-w-60"
        data-testid="sidebar-account-menu"
      >
        <div className="px-2 py-1.5 leading-tight">
          <p className="truncate text-sm font-medium" title={who ?? undefined}>
            {who ?? LITE_ACCOUNT_LABEL}
          </p>
          {plan ? <p className="truncate text-xs text-muted-foreground">{plan}</p> : null}
        </div>
        <MenuSeparator />
        {standing === "cloud" ? (
          // Plus and up without a machine yet: the one step that matters.
          <MenuItem onClick={openCloudWork} data-testid="lite-open-cloud">
            <SparklesIcon />
            Open Uno Work in the cloud
          </MenuItem>
        ) : null}
        {myUno.map((item) => (
          <MenuItem key={item.label} onClick={() => go(item.search)}>
            {item.icon}
            {item.label}
          </MenuItem>
        ))}
        <MenuSeparator />
        {external.map((item) => (
          <MenuItem
            key={item.label}
            onClick={() => openExternal(item.href)}
            data-testid={item.testId}
          >
            {item.icon}
            <span className="flex-1">{item.label}</span>
            {item.label === "Uno console" ? null : <ArrowUpRightIcon className="opacity-60" />}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            window.location.href = liteLinks.logout;
          }}
          data-testid="lite-sign-out"
        >
          <LogOutIcon />
          Sign out
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * Sidebar D as lite has it: the account button, New chat and Collapse on
 * top; the chats below. No places (Files, Apps & sites live on a computer),
 * no footer, no upsell.
 */
export function LiteSidebar() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const balance = useQuery(balanceQuery());
  const workAi = (balance.data?.features ?? []).includes(WORK_AI_FEATURE);
  const onAi = pathname.startsWith(LITE_AI_PATH);
  const newChat = () => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: LITE_AI_PATH, search: {} });
  };
  return (
    <>
      <SidebarHeader className="flex-row items-center gap-0.5 px-2 py-2 sm:py-2.5">
        <LiteAccountMenu />
        {workAi ? (
          <SidebarDHeaderIcon label="New chat" onClick={newChat} testId="sidebar-header-new-chat">
            <SquarePenIcon />
          </SidebarDHeaderIcon>
        ) : null}
        {isMobile ? null : (
          <SidebarDHeaderIcon
            label="Hide sidebar"
            hint="Hide sidebar · ⌘B"
            onClick={() => setOpen(false)}
            testId="sidebar-collapse"
          >
            <PanelLeftCloseIcon />
          </SidebarDHeaderIcon>
        )}
      </SidebarHeader>
      <SidebarContent className="gap-0">
        {workAi ? <LiveBotTile /> : null}
        <SidebarGroup className="px-[var(--sidebar-content-inset)] pt-1 pb-1">
          {workAi ? <UnoAiSidebarChats active={onAi} /> : null}
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}
