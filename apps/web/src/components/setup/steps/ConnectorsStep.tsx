/**
 * Step 5 — tools the AI can work in.
 * - Google Drive, GitHub, Notion, Gmail & Calendar: the account's own OAuth
 *   grants, kept by the console; the computer's agents get their tools in the
 *   built-in uno-work MCP server (`/api/manager/connectors`). "Connect" opens
 *   the provider's consent in a small window; the row turns "Connected ·
 *   <account>" when the grant lands. A provider the console has no OAuth app
 *   for yet is shown, marked Soon, not clickable. GitHub falls back to this
 *   computer's own `gh` sign-in then.
 * - Email for your AI (first, when the account has it): the computer's own
 *   address on uno4.me for sign-ups and mail the AI writes as itself, with
 *   Copy and "Change name" (`/api/manager/mail`, spec 20.10). Hidden
 *   entirely while the console doesn't report a mailbox.
 * - Your own tool: a remote MCP server by address, checked first (it must
 *   answer and list its tools), then handed to every agent in new chats
 *   (`settings.mcpServers`, see customMcpServers.ts on the daemon).
 */
import { UNO_MCP_SERVER_NAME_PATTERN, type UnoMcpServer } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2Icon, MailIcon, ServerIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import {
  changeAgentMailAddress,
  connectGithubAccount,
  disconnectConnector,
  getAgentMail,
  getGithubAccount,
  listConnectors,
  openAuthWindow,
  probeMcpServer,
  startConnector,
  type ConnectorProvider,
  type McpProbeResult,
  type SetupConnector,
} from "../../../lib/setupApi";
import { useSourceControlDiscovery } from "../../../lib/sourceControlDiscoveryState";
import { cn } from "../../../lib/utils";
import { GitHubIcon } from "../../Icons";
import { CopyButton } from "../../computer/computerUi";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { toastManager } from "../../ui/toast";
import { GmailMark, GoogleCalendarMark, GoogleDriveMark, NotionMark } from "../brandMarks";
import { connectorSignedIn } from "../connectorSignIn.logic";
import { ConnectedBadge, SetupHeading, SetupShell, SoonBadge } from "../SetupShell";
import { useSetupNavigation } from "../useSetupNavigation";
import { maskServerUrl } from "../../connectors/connectorsCatalog.logic";
import {
  AGENT_MAIL_NAME_HINT,
  agentMailChangeError,
  agentMailDomain,
  agentMailLocalProblem,
  agentMailPreview,
  agentMailRowVisible,
  normalizeAgentMailLocal,
} from "../agentMail.logic";

/** A short config name from the server's address: `mcp.context7.com` → `context7`. */
export function mcpServerNameFromUrl(url: string, taken: ReadonlyArray<string>): string | null {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    host = parsed.hostname;
  } catch {
    return null;
  }
  const labels = host
    .toLowerCase()
    .split(".")
    .filter((label) => label && !["mcp", "www", "api"].includes(label));
  const base =
    (labels.length > 1 ? labels[labels.length - 2] : labels[0])
      ?.replace(/[^a-z0-9_-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 40) || "tool";
  let name = UNO_MCP_SERVER_NAME_PATTERN.test(base) ? base : "tool";
  for (let n = 2; taken.includes(name); n += 1) name = `${base}-${n}`.slice(0, 48);
  return name;
}

/** Plain words for a failed check of a server. */
export function mcpProbeProblem(result: McpProbeResult): string {
  if (result.needsAuth) {
    return "This server asks for a sign-in. Use an address that includes its key, or add it anyway and your AI will ask when it needs to.";
  }
  if (result.error) return `It didn't answer like a tool server: ${result.error}`;
  return "It didn't answer like a tool server.";
}

export interface ProviderMeta {
  readonly provider: ConnectorProvider;
  readonly name: string;
  readonly description: string;
  readonly logo: ReactNode;
}

/** The mockup's order and words; the console's list fills in the state. */
export const PROVIDERS: ReadonlyArray<ProviderMeta> = [
  {
    provider: "google-drive",
    name: "Google Drive",
    description: "Only files Uno created or you picked for it — not your whole Drive.",
    logo: <GoogleDriveMark className="size-5" />,
  },
  {
    provider: "github",
    name: "GitHub",
    description: "Reads and pushes to all your repos, private ones too; issues and PRs.",
    logo: <GitHubIcon className="size-5" />,
  },
  {
    provider: "notion",
    name: "Notion",
    description: "Only the pages you shared with Uno; reads and edits them.",
    logo: <NotionMark className="size-5 text-foreground" />,
  },
  {
    provider: "gmail",
    name: "Gmail & Calendar",
    description: "Reads, drafts and sends mail, can move it to Trash; reads your calendar.",
    logo: (
      <>
        <GmailMark className="size-4" />
        <GoogleCalendarMark className="size-3.5" />
      </>
    ),
  },
];

function Row({
  logo,
  name,
  description,
  side,
  muted = false,
  first = false,
  done = false,
  testId,
}: {
  logo: ReactNode;
  name: string;
  description: ReactNode;
  side: ReactNode;
  muted?: boolean;
  first?: boolean;
  done?: boolean;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-4 px-4 py-3.5 sm:px-5",
        !first && "border-t border-border",
        done && "bg-success/[0.03]",
      )}
      aria-disabled={muted || undefined}
      data-testid={testId}
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center gap-0.5 rounded-xl border border-border bg-background",
          muted && "opacity-60",
        )}
      >
        {logo}
      </span>
      <div className={cn("min-w-0 flex-1", muted && "opacity-60")}>
        <div className="font-medium">{name}</div>
        <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
      </div>
      <div className="shrink-0">{side}</div>
    </div>
  );
}

export const CONNECTORS_KEY = ["uno-setup", "connectors"] as const;

export function useConnectors(environmentId: ReturnType<typeof usePrimaryEnvironmentId>) {
  return useQuery({
    queryKey: [...CONNECTORS_KEY, environmentId],
    queryFn: async () => {
      try {
        return await listConnectors({ environmentId: environmentId! });
      } catch {
        // An older daemon without the route, or the account out of reach:
        // the providers show as Soon, your own server still works.
        return { available: false, reason: "unavailable", connectors: [] };
      }
    },
    enabled: environmentId !== null,
    staleTime: 10_000,
  });
}

const GITHUB_ACCOUNT_KEY = ["uno-setup", "github-account"] as const;
/** How long to keep checking after GitHub's page opened. */
const GITHUB_WAIT_MS = 180_000;

/**
 * GitHub of the account (the Uno GitHub App): one Connect, the repositories
 * picked on GitHub's page, and git on every cloud computer signs in by itself.
 * Off a cloud computer (or an older console) it falls back to this
 * computer's own `gh` sign-in.
 */
function GitHubAccountRow({ first }: { first: boolean }) {
  const environmentId = usePrimaryEnvironmentId();
  const [waitingUntil, setWaitingUntil] = useState<number | null>(null);
  const account = useQuery({
    queryKey: [...GITHUB_ACCOUNT_KEY, environmentId],
    queryFn: () => getGithubAccount({ environmentId: environmentId! }),
    enabled: environmentId !== null,
    retry: false,
    refetchInterval: waitingUntil !== null ? 3000 : false,
  });
  const state = account.data;
  const connected = state?.connected === true;
  useEffect(() => {
    if (waitingUntil === null) return;
    if (connected) {
      setWaitingUntil(null);
      return;
    }
    const timer = window.setTimeout(() => setWaitingUntil(null), waitingUntil - Date.now());
    return () => window.clearTimeout(timer);
  }, [waitingUntil, connected]);

  if (account.isError || (state && !state.available)) return <GitHubMachineRow first={first} />;

  const open = async () => {
    if (!environmentId) return;
    try {
      const { authorizeUrl } = await connectGithubAccount({ environmentId });
      setWaitingUntil(Date.now() + GITHUB_WAIT_MS);
      await openAuthWindow(authorizeUrl, "uno-connector");
      await account.refetch();
    } catch (cause) {
      setWaitingUntil(null);
      toastManager.add({
        type: "error",
        title: "Couldn’t open GitHub",
        description: cause instanceof Error ? cause.message : undefined,
      });
    }
  };
  const waiting = waitingUntil !== null && !connected;
  return (
    <Row
      first={first}
      done={connected}
      logo={<GitHubIcon className="size-5" />}
      name="GitHub"
      testId="setup-connector-github"
      description={
        connected ? (
          <ConnectedBadge>
            Connected{state.accounts.length > 0 ? ` · ${state.accounts.join(", ")}` : ""}
          </ConnectedBadge>
        ) : (
          "Your repositories for git on every computer. You pick them on GitHub."
        )
      }
      side={
        !state ? (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <Button
            size="sm"
            variant={connected ? "ghost" : "outline"}
            disabled={waiting}
            onClick={() => void open()}
            data-testid="setup-connect-github-account"
          >
            {waiting ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {waiting ? "Waiting for GitHub" : connected ? "Choose repositories" : "Connect"}
          </Button>
        )
      }
    />
  );
}

/** This computer's own `gh` sign-in — GitHub's fallback while the connector isn't available. */
function GitHubMachineRow({ first }: { first: boolean }) {
  const discovery = useSourceControlDiscovery();
  const navigate = useNavigate();
  const github = discovery.data?.sourceControlProviders.find((item) => item.kind === "github");
  const signedIn = github?.auth.status === "authenticated";
  const account = github?.auth.account._tag === "Some" ? github.auth.account.value : null;
  return (
    <Row
      first={first}
      done={signedIn}
      logo={<GitHubIcon className="size-5" />}
      name="GitHub"
      testId="setup-connector-github"
      description={
        signedIn ? (
          <ConnectedBadge>Connected{account ? ` · ${account}` : ""}</ConnectedBadge>
        ) : (
          "Repos, issues and pull requests, through this computer’s GitHub sign-in."
        )
      }
      side={
        discovery.isPending && !discovery.data ? (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : signedIn ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: "/settings/source-control" })}
          >
            Connect
          </Button>
        )
      }
    />
  );
}

const AGENT_MAIL_KEY = ["uno-setup", "agent-mail"] as const;

/** The computer's own mailbox; undefined (row hidden) until the daemon answers, or on any error. */
function useAgentMail(environmentId: ReturnType<typeof usePrimaryEnvironmentId>) {
  return useQuery({
    queryKey: [...AGENT_MAIL_KEY, environmentId],
    queryFn: () => getAgentMail({ environmentId: environmentId! }),
    enabled: environmentId !== null,
    retry: false,
    staleTime: 30_000,
  });
}

/** "Email for your AI": the address, Copy, Change name. */
function AgentMailRow({
  environmentId,
  mailbox,
}: {
  environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  mailbox: { readonly address: string; readonly local: string };
}) {
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      <Row
        first
        logo={<MailIcon className="size-5 text-muted-foreground" />}
        name="Email for your AI"
        testId="setup-connector-agent-mail"
        description={
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1">
              <span
                className="truncate font-mono text-sm text-foreground"
                data-testid="agent-mail-address"
              >
                {mailbox.address}
              </span>
              <CopyButton value={mailbox.address} label="email address" />
            </span>
            <span>
              Its own address for sign-ups and letters it writes. Your mail stays in Gmail.
            </span>
          </span>
        }
        side={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRenaming(true)}
            data-testid="agent-mail-change-name"
          >
            Change name
          </Button>
        }
      />
      <AgentMailRenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        environmentId={environmentId}
        mailbox={mailbox}
      />
    </>
  );
}

function AgentMailRenameDialog({
  open,
  onOpenChange,
  environmentId,
  mailbox,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironmentId>>;
  mailbox: { readonly address: string; readonly local: string };
}) {
  const queryClient = useQueryClient();
  const domain = agentMailDomain(mailbox.address);
  const [value, setValue] = useState(mailbox.local);
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setValue(mailbox.local);
    setTouched(false);
    setServerError(null);
  }, [open, mailbox.local]);

  const local = normalizeAgentMailLocal(value);
  const problem = agentMailLocalProblem(value);
  const unchanged = local === mailbox.local;
  const shownProblem = serverError ?? (touched && !unchanged ? problem : null);

  const save = async () => {
    setTouched(true);
    if (problem !== null || unchanged || pending) return;
    setPending(true);
    setServerError(null);
    try {
      const { address } = await changeAgentMailAddress({ environmentId, local });
      await queryClient.invalidateQueries({ queryKey: AGENT_MAIL_KEY });
      onOpenChange(false);
      toastManager.add({
        type: "success",
        title: "Address changed",
        description: `Your AI now gets mail at ${address}. Mail to the old address still arrives for 30 days.`,
      });
    } catch (cause) {
      setServerError(agentMailChangeError(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change the email name</DialogTitle>
          <DialogDescription>
            Pick the name before @{domain}. Mail to {mailbox.address} keeps arriving for 30 days.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-center gap-2">
            <Input
              className="min-w-0 flex-1 font-mono"
              value={value}
              autoFocus
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              maxLength={40}
              aria-label="Email name"
              aria-invalid={shownProblem !== null || undefined}
              onChange={(event) => {
                setValue(event.target.value);
                setTouched(true);
                setServerError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
              }}
              data-testid="agent-mail-name-input"
            />
            <span className="shrink-0 font-mono text-sm text-muted-foreground">@{domain}</span>
          </div>
          <div className="mt-3 text-sm">
            <span className="text-muted-foreground">New address: </span>
            <span className="font-mono" data-testid="agent-mail-preview">
              {agentMailPreview(value, domain)}
            </span>
          </div>
          <div
            className={cn(
              "mt-2 text-xs",
              shownProblem ? "text-destructive-foreground" : "text-muted-foreground",
            )}
            role={shownProblem ? "alert" : undefined}
          >
            {shownProblem ?? AGENT_MAIL_NAME_HINT}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={pending || unchanged || problem !== null}
            onClick={() => void save()}
            data-testid="agent-mail-save"
          >
            {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {pending ? "Saving" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ProviderRow({
  meta,
  connector,
  first,
  pending,
  onConnect,
  onDisconnect,
}: {
  meta: ProviderMeta;
  connector: SetupConnector | undefined;
  first: boolean;
  pending: "connect" | "disconnect" | null;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const available = connector?.available === true;
  const connected = connectorSignedIn(connector);
  let side: ReactNode;
  if (!available) side = <SoonBadge />;
  else if (connected) {
    side = (
      <Button size="sm" variant="ghost" disabled={pending !== null} onClick={onDisconnect}>
        {pending === "disconnect" ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
        Disconnect
      </Button>
    );
  } else {
    side = (
      <Button
        size="sm"
        variant="outline"
        disabled={pending !== null}
        onClick={onConnect}
        data-testid={`setup-connect-${meta.provider}`}
      >
        {pending === "connect" ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
        {pending === "connect" ? "Connecting" : connector?.needsReconnect ? "Reconnect" : "Connect"}
      </Button>
    );
  }
  return (
    <Row
      first={first}
      done={connected}
      muted={!available}
      logo={meta.logo}
      name={meta.name}
      testId={`setup-connector-${meta.provider}`}
      description={
        connected ? (
          <ConnectedBadge>
            Connected{connector?.account ? ` · ${connector.account}` : ""}
          </ConnectedBadge>
        ) : connector?.needsReconnect ? (
          "It stopped working. Sign in again to keep it."
        ) : (
          meta.description
        )
      }
      side={side}
    />
  );
}

function McpServers({
  environmentId,
}: {
  environmentId: ReturnType<typeof usePrimaryEnvironmentId>;
}) {
  const servers = useSettings((settings) => settings.mcpServers);
  const { updateSettings } = useUpdateSettings();
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState<string | null>(null);

  // What each added server offers, checked on this page (cached briefly).
  const probes = useQuery({
    queryKey: ["uno-setup", "mcp-probe", environmentId, servers.map((server) => server.url)],
    queryFn: async () => {
      const out = new Map<string, McpProbeResult | null>();
      for (const server of servers) {
        try {
          out.set(
            server.url,
            await probeMcpServer({ environmentId: environmentId!, url: server.url }),
          );
        } catch {
          out.set(server.url, null);
        }
      }
      return out;
    },
    enabled: environmentId !== null && servers.length > 0,
    staleTime: 60_000,
  });

  const save = async (next: ReadonlyArray<UnoMcpServer>) => {
    try {
      await updateSettings({ mcpServers: next });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save.");
      return false;
    }
  };

  const add = async (force = false) => {
    const value = url.trim();
    const name = mcpServerNameFromUrl(
      value,
      servers.map((server) => server.name),
    );
    if (!name) {
      setError("Paste the server’s https:// address, e.g. https://mcp.example.com/mcp");
      return;
    }
    if (servers.some((server) => server.url === value)) {
      setError("This server is already added.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (!force && environmentId) {
        let result: McpProbeResult | null = null;
        try {
          result = await probeMcpServer({ environmentId, url: value });
        } catch {
          result = null; // an older daemon can't check: add as before
        }
        if (result && !result.ok) {
          setError(mcpProbeProblem(result));
          setUnchecked(value);
          return;
        }
      }
      if (await save([...servers, { name, url: value, enabled: true }])) {
        setUrl("");
        setUnchecked(null);
        toastManager.add({ type: "success", title: "MCP server added" });
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      {servers.map((server) => {
        const probe = probes.data?.get(server.url);
        return (
          <Row
            key={server.name}
            done
            logo={<ServerIcon className="size-5 text-muted-foreground" />}
            name={`${server.name} · your MCP server`}
            testId="setup-mcp-server"
            description={
              <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                <ConnectedBadge>
                  {probe && probe.ok
                    ? `Connected · ${probe.toolCount} ${probe.toolCount === 1 ? "tool" : "tools"}`
                    : "Added · new chats get its tools"}
                </ConnectedBadge>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {maskServerUrl(server.url)}
                </span>
              </span>
            }
            side={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void save(servers.filter((entry) => entry.name !== server.name))}
              >
                Remove
              </Button>
            }
          />
        );
      })}
      <div className="flex items-start gap-4 border-t border-border px-4 py-3.5 sm:px-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
          <ServerIcon className="size-5 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">Your own tool (MCP server)</div>
          <div className="mt-0.5 text-sm text-muted-foreground">
            Paste its address. Every chat on this computer gets its tools.
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Input
              className="min-w-[220px] flex-1 font-mono"
              placeholder="https://mcp.example.com/mcp"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
                setUnchecked(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void add();
              }}
              aria-label="MCP server address"
              spellCheck={false}
              data-testid="setup-mcp-url"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void add()}
              disabled={pending || !url.trim()}
              data-testid="setup-mcp-add"
            >
              {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {pending ? "Checking" : "Add"}
            </Button>
          </div>
          {error ? (
            <div className="mt-2 text-xs text-destructive-foreground">
              {error}
              {unchecked === url.trim() ? (
                <>
                  {" "}
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline"
                    onClick={() => void add(true)}
                  >
                    Add anyway
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

/**
 * Connect / Disconnect of the four apps: the provider's consent in a small
 * window, then the list is looked at until the grant lands. Shared by the
 * list and by the places that offer "Connect GitHub" inline (the teammate's
 * setup when nothing is connected yet).
 */
export function useConnectorActions(environmentId: ReturnType<typeof usePrimaryEnvironmentId>) {
  const queryClient = useQueryClient();
  const connectors = useConnectors(environmentId);
  const [pending, setPending] = useState<{
    provider: ConnectorProvider;
    action: "connect" | "disconnect";
  } | null>(null);
  const byProvider = new Map(
    (connectors.data?.connectors ?? []).map((connector) => [connector.provider, connector]),
  );

  // While a consent window is open, look for the grant every two seconds: the
  // desktop app opens it in the system browser, which can't message back.
  useEffect(() => {
    if (pending?.action !== "connect") return;
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: CONNECTORS_KEY });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pending, queryClient]);
  useEffect(() => {
    if (pending?.action !== "connect") return;
    // Reconnect: the expired grant is listed as connected until the new one lands.
    if (connectorSignedIn(byProvider.get(pending.provider))) {
      toastManager.add({
        type: "success",
        title: `${PROVIDERS.find((meta) => meta.provider === pending.provider)?.name} connected`,
      });
      setPending(null);
    }
  });

  const connect = async (provider: ConnectorProvider) => {
    if (!environmentId) return;
    setPending({ provider, action: "connect" });
    try {
      const { authorizeUrl } = await startConnector({ environmentId, provider });
      const result = await openAuthWindow(authorizeUrl, "uno-connector");
      await queryClient.invalidateQueries({ queryKey: CONNECTORS_KEY });
      // A closed window without a word back: give the list one more look.
      if (!result.ok) window.setTimeout(() => setPending(null), 2500);
    } catch (cause) {
      setPending(null);
      toastManager.add({
        type: "error",
        title: "Couldn't start the sign-in",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const disconnect = async (provider: ConnectorProvider) => {
    if (!environmentId) return;
    setPending({ provider, action: "disconnect" });
    try {
      await disconnectConnector({ environmentId, provider });
    } finally {
      await queryClient.invalidateQueries({ queryKey: CONNECTORS_KEY });
      setPending(null);
    }
  };

  return { connectors, byProvider, pending, connect, disconnect };
}

/**
 * The list itself — the four apps in one click and servers of your own. Used
 * by this step and by Settings → Connectors (the place to manage them since
 * 16.10), so both show the same thing.
 */
export function ConnectorsList(props: { readonly className?: string } = {}) {
  const environmentId = usePrimaryEnvironmentId();
  const { connectors, byProvider, pending, connect, disconnect } =
    useConnectorActions(environmentId);
  const githubConnector = byProvider.get("github");
  const githubViaMachine = connectors.isFetched && githubConnector?.available !== true;
  const agentMail = useAgentMail(environmentId);
  const mailbox = agentMailRowVisible(agentMail.data) ? agentMail.data.mailbox : null;
  const mailShown = environmentId !== null && mailbox !== null;

  return (
    <div
      className={cn("overflow-hidden rounded-2xl border border-border", props.className)}
      data-testid="setup-connectors"
    >
      {environmentId !== null && mailbox !== null ? (
        <AgentMailRow environmentId={environmentId} mailbox={mailbox} />
      ) : null}
      {PROVIDERS.map((meta, index) =>
        meta.provider === "github" && githubViaMachine ? (
          <GitHubAccountRow key={meta.provider} first={index === 0 && !mailShown} />
        ) : (
          <ProviderRow
            key={meta.provider}
            meta={meta}
            connector={byProvider.get(meta.provider)}
            first={index === 0 && !mailShown}
            pending={pending?.provider === meta.provider ? pending.action : null}
            onConnect={() => void connect(meta.provider)}
            onDisconnect={() => void disconnect(meta.provider)}
          />
        ),
      )}
      <McpServers environmentId={environmentId} />
    </div>
  );
}

export function ConnectorsStep() {
  const { completeStep } = useSetupNavigation();
  const environmentId = usePrimaryEnvironmentId();
  const servers = useSettings((settings) => settings.mcpServers);
  const connectors = useConnectors(environmentId);
  const connectedCount = (connectors.data?.connectors ?? []).filter(
    (connector) => connector.connected,
  ).length;
  return (
    <SetupShell
      step="connectors"
      primary={{
        label: servers.length > 0 || connectedCount > 0 ? "Continue" : "Continue without tools",
        onClick: () => void completeStep("connectors"),
      }}
    >
      <SetupHeading
        title="Connect your tools"
        lead="Let your AI read and work where your stuff already is. You approve each one, and can disconnect any time."
      />
      <ConnectorsList />
    </SetupShell>
  );
}
