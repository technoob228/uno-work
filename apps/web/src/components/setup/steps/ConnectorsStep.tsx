/**
 * Step 5 — tools the AI can work in. What's real today:
 * - GitHub: the machine's own `gh` sign-in (Settings → Source control);
 * - your own tool: a remote MCP server by address, handed to every agent on
 *   the machine in new chats (`settings.mcpServers`, see customMcpServers.ts
 *   on the daemon).
 * Google Drive, Notion and Gmail need an OAuth app we don't have yet: shown,
 * marked Soon, not clickable.
 */
import { UNO_MCP_SERVER_NAME_PATTERN, type UnoMcpServer } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Loader2Icon, ServerIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { useSourceControlDiscovery } from "../../../lib/sourceControlDiscoveryState";
import { cn } from "../../../lib/utils";
import { GitHubIcon } from "../../Icons";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
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

function Row({
  logo,
  name,
  description,
  side,
  muted = false,
  first = false,
}: {
  logo: ReactNode;
  name: string;
  description: ReactNode;
  side: ReactNode;
  muted?: boolean;
  first?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-4 px-4 py-3.5 sm:px-5",
        !first && "border-t border-border",
        muted && "opacity-60",
      )}
      aria-disabled={muted || undefined}
    >
      <span className="flex size-10 shrink-0 items-center justify-center gap-0.5 rounded-xl border border-border bg-background">
        {logo}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{name}</div>
        <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>
      </div>
      <div className="shrink-0">{side}</div>
    </div>
  );
}

function GitHubRow() {
  const discovery = useSourceControlDiscovery();
  const navigate = useNavigate();
  const github = discovery.data?.sourceControlProviders.find((item) => item.kind === "github");
  const signedIn = github?.auth.status === "authenticated";
  const account = github?.auth.account._tag === "Some" ? github.auth.account.value : null;
  return (
    <Row
      logo={<GitHubIcon className="size-5" />}
      name="GitHub"
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
            Set up
          </Button>
        )
      }
    />
  );
}

function McpServers() {
  const servers = useSettings((settings) => settings.mcpServers);
  const { updateSettings } = useUpdateSettings();
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: ReadonlyArray<UnoMcpServer>) => {
    setPending(true);
    setError(null);
    try {
      await updateSettings({ mcpServers: next });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save.");
      return false;
    } finally {
      setPending(false);
    }
  };

  const add = async () => {
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
    if (await save([...servers, { name, url: value, enabled: true }])) setUrl("");
  };

  return (
    <>
      {servers.map((server) => (
        <Row
          key={server.name}
          logo={<ServerIcon className="size-5 text-muted-foreground" />}
          name={`Your tool · ${server.name}`}
          description={
            <span className="flex min-w-0 flex-wrap items-center gap-x-2">
              <ConnectedBadge>Added · new chats get its tools</ConnectedBadge>
              <span className="truncate font-mono text-xs">{server.url}</span>
            </span>
          }
          side={
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => void save(servers.filter((entry) => entry.name !== server.name))}
            >
              Remove
            </Button>
          }
        />
      ))}
      <div className="flex items-start gap-4 border-t border-border px-4 py-3.5 sm:px-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
          <ServerIcon className="size-5 text-muted-foreground" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">Your own tool (MCP server)</div>
          <div className="mt-0.5 text-sm text-muted-foreground">
            Paste its address. Your AI gets its tools in every new chat.
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Input
              className="min-w-[220px] flex-1 font-mono"
              placeholder="https://mcp.example.com/mcp"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                setError(null);
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
            >
              {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              Add
            </Button>
          </div>
          {error ? <div className="mt-2 text-xs text-destructive-foreground">{error}</div> : null}
        </div>
      </div>
    </>
  );
}

export function ConnectorsStep() {
  const { completeStep } = useSetupNavigation();
  const servers = useSettings((settings) => settings.mcpServers);
  return (
    <SetupShell
      step="connectors"
      primary={{
        label: servers.length > 0 ? "Continue" : "Continue without tools",
        onClick: () => void completeStep("connectors"),
      }}
    >
      <SetupHeading
        title="Connect your tools"
        lead="Let your AI read and work where your stuff already is. You approve each one, and can disconnect any time."
      />
      <div className="overflow-hidden rounded-2xl border border-border">
        <GitHubRow />
        <McpServers />
        <Row
          logo={<GoogleDriveMark className="size-5" />}
          name="Google Drive"
          description="Read your files and save new ones."
          side={<SoonBadge />}
          muted
        />
        <Row
          logo={<NotionMark className="size-5 text-foreground" />}
          name="Notion"
          description="Pages and databases you share with Uno."
          side={<SoonBadge />}
          muted
        />
        <Row
          logo={
            <>
              <GmailMark className="size-4" />
              <GoogleCalendarMark className="size-3.5" />
            </>
          }
          name="Gmail & Calendar"
          description="Read mail, draft replies, see your day."
          side={<SoonBadge />}
          muted
        />
      </div>
    </SetupShell>
  );
}
