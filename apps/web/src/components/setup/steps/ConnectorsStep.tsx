/**
 * Step 5 — tools the AI can work in.
 * - Google Drive, GitHub, Notion, Gmail & Calendar: the account's own OAuth
 *   grants, kept by the console; the computer's agents get their tools in the
 *   built-in uno-work MCP server (`/api/manager/connectors`). "Connect" opens
 *   the provider's consent in a small window; the row turns "Connected ·
 *   <account>" when the grant lands. A provider the console has no OAuth app
 *   for yet is shown, marked Soon, not clickable. GitHub falls back to this
 *   computer's own `gh` sign-in then.
 * - Your own tool: a remote MCP server by address, checked first (it must
 *   answer and list its tools), then handed to every agent in new chats
 *   (`settings.mcpServers`, see customMcpServers.ts on the daemon).
 */
import { UNO_MCP_SERVER_NAME_PATTERN, type UnoMcpServer } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2Icon, ServerIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import {
  disconnectConnector,
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
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { toastManager } from "../../ui/toast";
import { GmailMark, GoogleCalendarMark, GoogleDriveMark, NotionMark } from "../brandMarks";
import { ConnectedBadge, SetupHeading, SetupShell, SoonBadge } from "../SetupShell";
import { useSetupNavigation } from "../useSetupNavigation";

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

interface ProviderMeta {
  readonly provider: ConnectorProvider;
  readonly name: string;
  readonly description: string;
  readonly logo: ReactNode;
}

/** The mockup's order and words; the console's list fills in the state. */
const PROVIDERS: ReadonlyArray<ProviderMeta> = [
  {
    provider: "google-drive",
    name: "Google Drive",
    description: "Read your files and save new ones.",
    logo: <GoogleDriveMark className="size-5" />,
  },
  {
    provider: "github",
    name: "GitHub",
    description: "Repos, issues and pull requests.",
    logo: <GitHubIcon className="size-5" />,
  },
  {
    provider: "notion",
    name: "Notion",
    description: "Pages and databases you share with Uno.",
    logo: <NotionMark className="size-5 text-foreground" />,
  },
  {
    provider: "gmail",
    name: "Gmail & Calendar",
    description: "Read mail, draft replies, see your day.",
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

const CONNECTORS_KEY = ["uno-setup", "connectors"] as const;

function useConnectors(environmentId: ReturnType<typeof usePrimaryEnvironmentId>) {
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
  const connected = connector?.connected === true && connector.needsReconnect !== true;
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
            name={servers.length > 1 ? `Your MCP server · ${server.name}` : "Your MCP server"}
            testId="setup-mcp-server"
            description={
              <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                <ConnectedBadge>
                  {probe && probe.ok
                    ? `Connected · ${probe.toolCount} ${probe.toolCount === 1 ? "tool" : "tools"}`
                    : "Added · new chats get its tools"}
                </ConnectedBadge>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {server.url}
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
            Paste its address. Your AI gets its tools in every chat.
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

export function ConnectorsStep() {
  const { completeStep } = useSetupNavigation();
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const servers = useSettings((settings) => settings.mcpServers);
  const connectors = useConnectors(environmentId);
  const [pending, setPending] = useState<{
    provider: ConnectorProvider;
    action: "connect" | "disconnect";
  } | null>(null);
  const byProvider = new Map(
    (connectors.data?.connectors ?? []).map((connector) => [connector.provider, connector]),
  );
  const connectedCount = [...byProvider.values()].filter((connector) => connector.connected).length;

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
    if (byProvider.get(pending.provider)?.connected) {
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

  const githubConnector = byProvider.get("github");
  const githubViaMachine = connectors.isFetched && githubConnector?.available !== true;

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
      <div
        className="overflow-hidden rounded-2xl border border-border"
        data-testid="setup-connectors"
      >
        {PROVIDERS.map((meta, index) =>
          meta.provider === "github" && githubViaMachine ? (
            <GitHubMachineRow key={meta.provider} first={index === 0} />
          ) : (
            <ProviderRow
              key={meta.provider}
              meta={meta}
              connector={byProvider.get(meta.provider)}
              first={index === 0}
              pending={pending?.provider === meta.provider ? pending.action : null}
              onConnect={() => void connect(meta.provider)}
              onDisconnect={() => void disconnect(meta.provider)}
            />
          ),
        )}
        <McpServers environmentId={environmentId} />
      </div>
    </SetupShell>
  );
}
