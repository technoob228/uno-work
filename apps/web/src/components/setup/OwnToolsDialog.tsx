/**
 * "Use your own tools": this computer without Uno Work's screens.
 *
 * - My AI agent: connect Claude Code / Codex / Claude Desktop / Cursor to Uno
 *   through the published MCP server (`npx @uno4/mcp`) with an API key made
 *   in the console. Claude.ai and ChatGPT need a hosted MCP with "Sign in
 *   with Uno", which doesn't exist yet — marked Soon.
 * - SSH: the computer's ready-to-run SSH command (the same one as "For
 *   engineers" on its screen); keys live in the console.
 *
 * Carried over from feat/onboarding-paths (ConnectAgentStep / SshAccessStep).
 */
import { useQuery } from "@tanstack/react-query";
import { BotIcon, ExternalLinkIcon, KeyRoundIcon, TerminalSquareIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { cn } from "../../lib/utils";
import { computerStateQueryOptions } from "../computer/computerQueries";
import { CopyButton } from "../computer/computerUi";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";

export type OwnToolsTab = "agent" | "ssh";

/** Console → Secrets → API keys / SSH keys; the console's start flow for a clean SSH computer. */
export const CONSOLE_API_KEYS_URL = "https://console.uno4.dev/secrets?tab=tokens";
export const CONSOLE_SSH_KEYS_URL = "https://console.uno4.dev/secrets?tab=sshkeys";
export const CONSOLE_START_SSH_URL = "https://console.uno4.dev/start?path=ssh";

type AgentTarget = "claude-code" | "codex" | "desktop" | "web";

const AGENT_TARGETS: ReadonlyArray<{ id: AgentTarget; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "desktop", label: "Claude Desktop · Cursor" },
  { id: "web", label: "Claude.ai · ChatGPT" },
];

const AGENT_SNIPPET: Readonly<Record<Exclude<AgentTarget, "web">, string>> = {
  "claude-code": "claude mcp add uno --env UNO_API_KEY=YOUR_KEY -- npx -y @uno4/mcp",
  codex: "codex mcp add uno --env UNO_API_KEY=YOUR_KEY -- npx -y @uno4/mcp",
  desktop: `{
  "mcpServers": {
    "uno": {
      "command": "npx",
      "args": ["-y", "@uno4/mcp"],
      "env": { "UNO_API_KEY": "YOUR_KEY" }
    }
  }
}`,
};

function Code({ value, label }: { value: string; label: string }) {
  return (
    <div className="relative rounded-xl border border-border bg-muted/40">
      <pre className="overflow-x-auto p-3 pr-20 font-mono text-xs leading-relaxed whitespace-pre">
        {value}
      </pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton value={value} label={label} />
      </div>
    </div>
  );
}

function External({
  href,
  children,
  primary = false,
}: {
  href: string;
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant={primary ? "default" : "outline"}
      onClick={() => openInstallDocs(href)}
    >
      {children}
      <ExternalLinkIcon className="size-3 opacity-60" />
    </Button>
  );
}

function AgentTab() {
  const [target, setTarget] = useState<AgentTarget>("claude-code");
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-muted-foreground">
        Your agent gets Uno as a tool: it makes computers, runs commands on them, publishes sites.
        Two steps, once.
      </p>
      <div role="tablist" aria-label="Your agent" className="flex flex-wrap gap-1.5">
        {AGENT_TARGETS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={target === item.id}
            onClick={() => setTarget(item.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-sm transition-colors",
              target === item.id
                ? "border-primary bg-primary/10 text-primary"
                : "border-border hover:bg-muted/60",
            )}
          >
            {item.label}
            {item.id === "web" ? (
              <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Soon
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {target === "web" ? (
        <div className="rounded-xl border border-dashed border-border p-4 text-muted-foreground">
          Soon you&apos;ll add Uno in Claude.ai or ChatGPT as a connector and sign in with your Uno
          account — no keys to copy. Until then, Claude Code, Codex, Claude Desktop and Cursor
          connect today.
        </div>
      ) : (
        <ol className="flex flex-col gap-4">
          <li className="flex flex-col gap-2">
            <div className="font-medium">1. Make a key for your agent</div>
            <p className="text-muted-foreground">
              In the Uno console, under API keys. Give the agent its own key — you can switch it off
              any time without touching anything else.
            </p>
            <div>
              <External href={CONSOLE_API_KEYS_URL}>
                <KeyRoundIcon className="size-3.5" />
                Open API keys
              </External>
            </div>
          </li>
          <li className="flex flex-col gap-2">
            <div className="font-medium">
              2.{" "}
              {target === "desktop"
                ? "Add Uno to the app’s MCP settings"
                : "Paste this where your agent lives"}
            </div>
            <p className="text-muted-foreground">
              {target === "desktop"
                ? "Claude Desktop: Settings → Developer → Edit config. Cursor: Settings → MCP. Put your key in place of YOUR_KEY, then restart the app."
                : "In your terminal. Put your key in place of YOUR_KEY."}
            </p>
            <Code value={AGENT_SNIPPET[target]} label="Command" />
          </li>
        </ol>
      )}
    </div>
  );
}

function SshTab() {
  const environmentId = usePrimaryEnvironmentId();
  const machine = useActiveMachine();
  const state = useQuery({
    ...computerStateQueryOptions(environmentId, null),
    enabled: environmentId !== null && machine.isCloud,
  });
  const box = state.data?.own ? state.data.box : null;
  const loading = machine.isCloud && state.isPending;

  if (loading) return <Skeleton className="h-28 w-full rounded-xl" />;
  if (!box) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          SSH needs a cloud computer: a clean Linux machine in the Uno cloud, with your own key.
          Pick a size and add your key in the console — about ten seconds.
        </p>
        <div className="flex flex-wrap gap-2">
          <External href={CONSOLE_START_SSH_URL} primary>
            Get a cloud computer
          </External>
          <External href={CONSOLE_SSH_KEYS_URL}>Add my SSH key</External>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-muted-foreground">
        A normal Linux computer. Connect from your own terminal, like any server.
      </p>
      <div className="flex flex-col gap-2">
        <div className="font-medium">Connect</div>
        {box.ssh ? (
          <Code value={box.ssh} label="SSH command" />
        ) : (
          <p className="text-muted-foreground">
            No SSH address yet. It shows up here and under “For engineers” on the computer’s screen
            once it’s ready.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <div className="font-medium">Your key</div>
        <p className="text-muted-foreground">
          Uno logs you in with keys, not passwords. Save your public key under SSH keys in the
          console — it goes onto every new computer you make.
        </p>
        <div className="flex flex-wrap gap-2">
          <External href={CONSOLE_SSH_KEYS_URL}>
            <KeyRoundIcon className="size-3.5" />
            Open SSH keys
          </External>
          <External href={CONSOLE_START_SSH_URL}>Make a separate clean computer</External>
        </div>
      </div>
      <details className="rounded-xl border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm">No key yet? Make one in a minute</summary>
        <div className="mt-2 flex flex-col gap-2 text-muted-foreground">
          <p>On your Mac or PC, open Terminal and run:</p>
          <Code value="ssh-keygen -t ed25519" label="Command" />
          <p>Press Enter for every question. Then copy your public key:</p>
          <Code value="cat ~/.ssh/id_ed25519.pub" label="Command" />
        </div>
      </details>
    </div>
  );
}

export function OwnToolsDialog({
  open,
  tab,
  onTabChange,
  onOpenChange,
}: {
  open: boolean;
  tab: OwnToolsTab;
  onTabChange: (tab: OwnToolsTab) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Use your own tools</DialogTitle>
          <DialogDescription>Use this computer with your own tools instead.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div role="tablist" className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1">
            {(
              [
                ["agent", "My AI agent", BotIcon],
                ["ssh", "SSH", TerminalSquareIcon],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => onTabChange(value)}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium",
                  tab === value ? "bg-background shadow-xs" : "text-muted-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
          {tab === "agent" ? <AgentTab /> : <SshTab />}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The row under the final screens: "Prefer your own tools?" + the two doors. */
export function OwnToolsRow({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<OwnToolsTab>("agent");
  const show = (next: OwnToolsTab) => {
    setTab(next);
    setOpen(true);
  };
  return (
    <div className="mt-8 flex flex-col gap-3 rounded-2xl border border-border bg-muted/20 p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">
          Use this computer with your own tools instead.
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => show("agent")}>
          <BotIcon className="size-3.5" />
          Give this computer to my AI agent
        </Button>
        <Button size="sm" variant="outline" onClick={() => show("ssh")}>
          <TerminalSquareIcon className="size-3.5" />
          Just give me SSH
        </Button>
      </div>
      <OwnToolsDialog open={open} tab={tab} onTabChange={setTab} onOpenChange={setOpen} />
    </div>
  );
}
