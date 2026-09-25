/**
 * "Use your own tools": this computer without Uno Work's screens.
 *
 * - My AI agent: a key made right here for THIS computer (pinned to it,
 *   `POST /api/v1/boxes/{id}/work/agent-keys`), and one line to paste where
 *   the agent lives — Claude Code, Codex, Cursor. Claude.ai and ChatGPT add
 *   Uno as a custom connector by its address alone and sign in with Uno
 *   (OAuth on the console's remote MCP server, https://console.uno4.dev/api/v1/mcp —
 *   the same server and consent screen as the console's "Connect ChatGPT / Claude";
 *   "Which computers" there pins the connection to this one).
 * - SSH: the ready-to-run command and "Add your SSH key" — the key lands on
 *   this computer at once (`/work/ssh`, `/work/ssh-keys`).
 *
 * Both are the person's actions: they go through the account session of this
 * interface (app.uno4.work or the desktop app). Where there isn't one (the
 * computer's own address) the dialog points to the console instead.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BotIcon,
  CheckIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Loader2Icon,
  TerminalSquareIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { accountRequest, accountTransport } from "../../account/unoAccount";
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
/**
 * The console's remote MCP server (OAuth for connectors, bearer key for CLIs).
 * Under /api/v1: console.uno4.dev/mcp is the old @uno4/mcp node server.
 */
export const UNO_MCP_URL = "https://console.uno4.dev/api/v1/mcp";

/**
 * The address to add in Claude / ChatGPT. With this computer's id the
 * console's consent screen preselects "Only “<this computer>”" (the same
 * server, just `/computer/<id>`); without it the default is all computers.
 */
export function connectorUrl(boxId: number | null | undefined): string {
  return typeof boxId === "number" && Number.isInteger(boxId) && boxId > 0
    ? `${UNO_MCP_URL}/computer/${boxId}`
    : UNO_MCP_URL;
}

export type AgentTarget = "claude-code" | "codex" | "cursor" | "web";

const AGENT_TARGETS: ReadonlyArray<{ id: AgentTarget; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "web", label: "Claude or ChatGPT" },
];

/**
 * The console doesn't have the route yet (an older console) or this
 * interface may not call it: fall back to the console's own pages.
 */
export function consoleRouteMissing(error: unknown): boolean {
  const status = (error as { readonly status?: unknown } | null)?.status;
  return status === 404 || status === 405 || status === 403;
}

/** What the console answers when it makes a key (`/work/agent-keys`). */
export interface AgentKeyResult {
  readonly id: number;
  readonly name: string;
  readonly key: string;
  readonly mcp_url: string;
  readonly commands: Readonly<Record<string, string>>;
}

/** The line to paste for a client, from the console's answer (fallback: built here). */
export function agentCommand(target: Exclude<AgentTarget, "web">, key: AgentKeyResult): string {
  const fromConsole = key.commands[target];
  if (fromConsole) return fromConsole;
  const url = key.mcp_url || UNO_MCP_URL;
  if (target === "claude-code") {
    return `claude mcp add --transport http uno ${url} --header "Authorization: Bearer ${key.key}"`;
  }
  if (target === "codex") {
    return `[mcp_servers.uno]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${key.key}" }`;
  }
  return JSON.stringify(
    { mcpServers: { uno: { url, headers: { Authorization: `Bearer ${key.key}` } } } },
    null,
    2,
  );
}

function Code({ value, label }: { value: string; label: string }) {
  return (
    <div className="relative rounded-xl border border-border bg-muted/40">
      <pre className="overflow-x-auto p-3 pr-20 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
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

/** This computer as the account knows it (id, name, SSH command). */
function useOwnBox() {
  const environmentId = usePrimaryEnvironmentId();
  const machine = useActiveMachine();
  const state = useQuery({
    ...computerStateQueryOptions(environmentId, null),
    enabled: environmentId !== null && machine.isCloud,
  });
  const box = state.data?.own ? state.data.box : null;
  return { box, loading: machine.isCloud && state.isPending, isCloud: machine.isCloud };
}

function AgentTab() {
  const [target, setTarget] = useState<AgentTarget>("claude-code");
  const { box, loading } = useOwnBox();
  const account = accountTransport() !== "none";
  const [keys, setKeys] = useState<Partial<Record<AgentTarget, AgentKeyResult>>>({});
  const [off, setOff] = useState<Partial<Record<AgentTarget, boolean>>>({});
  const mint = useMutation({
    mutationFn: async (client: Exclude<AgentTarget, "web">) =>
      (await accountRequest("POST", `/api/v1/boxes/${box!.id}/work/agent-keys`, {
        client,
      })) as AgentKeyResult,
    onSuccess: (key, client) => setKeys((current) => ({ ...current, [client]: key })),
  });
  const revoke = useMutation({
    mutationFn: async (client: AgentTarget) => {
      const key = keys[client];
      if (!key || !box) return;
      await accountRequest("DELETE", `/api/v1/boxes/${box.id}/work/agent-keys/${key.id}`);
    },
    onSuccess: (_, client) => setOff((current) => ({ ...current, [client]: true })),
  });
  const key = target === "web" ? undefined : keys[target];
  const boxName = box?.name ?? "this computer";

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-muted-foreground">
        Your agent gets this computer as a tool: it runs commands, installs anything, publishes
        sites. Paste one line where your agent lives.
      </p>
      <div className="flex flex-col gap-2">
        <div className="font-medium">Your agent</div>
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
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:bg-muted/60",
              )}
              data-testid={`own-agent-${item.id}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {target === "web" ? (
        <div className="flex flex-col gap-2">
          <Code
            value={`Settings → Connectors → Add custom connector\nURL: ${connectorUrl(box?.id)}`}
            label="Connector"
          />
          <p className="text-xs text-muted-foreground">
            {box
              ? `No key to copy: Claude or ChatGPT opens “Sign in with Uno”, with “Only ${boxName}” already chosen under “Which computers”.`
              : "No key to copy: Claude or ChatGPT opens “Sign in with Uno”, and you pick which computers it gets."}
          </p>
        </div>
      ) : loading ? (
        <Skeleton className="h-16 w-full rounded-xl" />
      ) : box && account && !consoleRouteMissing(mint.error) ? (
        key && !off[target] ? (
          <div className="flex flex-col gap-2">
            <Code value={agentCommand(target, key)} label="Command" />
            <p className="text-xs text-muted-foreground">
              The key works only for {boxName}.{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(target)}
              >
                Turn it off
              </button>{" "}
              any time.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {off[target] ? (
              <p className="text-xs text-muted-foreground">
                That key is off. Your agent can’t use {boxName} with it any more.
              </p>
            ) : null}
            <Button
              size="sm"
              className="self-start"
              disabled={mint.isPending}
              onClick={() => {
                setOff((current) => ({ ...current, [target]: false }));
                mint.mutate(target);
              }}
              data-testid="own-agent-make-key"
            >
              {mint.isPending ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <KeyRoundIcon className="size-3.5" />
              )}
              Make a key for {boxName}
            </Button>
            {mint.error ? (
              <p className="text-xs text-destructive-foreground">
                {mint.error instanceof Error ? mint.error.message : "Couldn’t make a key."}
              </p>
            ) : null}
          </div>
        )
      ) : (
        <ol className="flex flex-col gap-3">
          <li className="flex flex-col gap-2">
            <div className="font-medium">1. Make a key for your agent</div>
            <p className="text-muted-foreground">
              In the Uno console, under API keys. You can switch it off any time.
            </p>
            <div>
              <External href={CONSOLE_API_KEYS_URL}>
                <KeyRoundIcon className="size-3.5" />
                Open API keys
              </External>
            </div>
          </li>
          <li className="flex flex-col gap-2">
            <div className="font-medium">2. Paste this where your agent lives</div>
            <Code
              value={agentCommand(target, {
                id: 0,
                name: "",
                key: "YOUR_KEY",
                mcp_url: UNO_MCP_URL,
                commands: {},
              })}
              label="Command"
            />
          </li>
        </ol>
      )}
    </div>
  );
}

interface SshInfo {
  readonly available: boolean;
  readonly user: string;
  readonly host: string;
  readonly port: number;
  readonly command: string;
  readonly reason?: string | null;
  readonly keys: ReadonlyArray<{ fingerprint: string; comment: string; type: string }>;
}

/** One public key line, roughly checked before it goes to the console. */
export function sshKeyProblem(value: string): string | null {
  const line = value.trim();
  if (!line) return "Paste your public key: one line that starts with ssh-ed25519 or ssh-rsa.";
  if (line.includes("PRIVATE KEY")) return "That's the private key. Paste the .pub one instead.";
  if (
    !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( .*)?$/.test(
      line,
    )
  ) {
    return "That doesn't look like a public key. It starts with ssh-ed25519 or ssh-rsa.";
  }
  return null;
}

function SshTab() {
  const { box, loading, isCloud } = useOwnBox();
  const account = accountTransport() !== "none";
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const info = useQuery({
    queryKey: ["uno-setup", "ssh", box?.id ?? null],
    queryFn: async () =>
      (await accountRequest("GET", `/api/v1/boxes/${box!.id}/work/ssh`)) as SshInfo,
    enabled: box !== null && account,
    retry: false,
  });
  const add = useMutation({
    mutationFn: async (publicKey: string) =>
      (await accountRequest("POST", `/api/v1/boxes/${box!.id}/work/ssh-keys`, {
        public_key: publicKey,
      })) as { fingerprint: string; comment: string; type: string },
    onSuccess: () => {
      setValue("");
      void queryClient.invalidateQueries({ queryKey: ["uno-setup", "ssh"] });
    },
  });

  if (loading) return <Skeleton className="h-28 w-full rounded-xl" />;
  if (!box || !isCloud) {
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
  const command = info.data?.command || box.ssh;
  const keysHere = account && !consoleRouteMissing(info.error);
  const lastAdded = add.data;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-muted-foreground">
        A normal Linux computer with full access. Connect from your terminal:
      </p>
      <div className="flex flex-col gap-2">
        <div className="font-medium">Connect</div>
        {command ? (
          <Code value={command} label="SSH command" />
        ) : info.data && !info.data.available ? (
          <p className="text-muted-foreground">
            {info.data.reason ?? "SSH is off for this computer."}
          </p>
        ) : (
          <p className="text-muted-foreground">
            No SSH address yet. It shows up here once the computer is ready.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <div className="font-medium">Add your SSH key</div>
        {keysHere ? (
          <>
            {lastAdded ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
                <CheckIcon className="size-3.5" />
                Key added · {lastAdded.type.replace(/^ssh-/, "")}
                {lastAdded.comment ? ` · ${lastAdded.comment}` : ""}
              </span>
            ) : null}
            {(info.data?.keys.length ?? 0) > 0 && !lastAdded ? (
              <span className="text-xs text-muted-foreground">
                {info.data!.keys.length} {info.data!.keys.length === 1 ? "key" : "keys"} already
                work here: {info.data!.keys.map((key) => key.comment || key.fingerprint).join(", ")}
              </span>
            ) : null}
            <textarea
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setProblem(null);
              }}
              placeholder="ssh-ed25519 AAAAC3Nza… you@laptop"
              spellCheck={false}
              rows={3}
              className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring"
              aria-label="Your public SSH key"
              data-testid="own-ssh-key"
            />
            <div className="flex items-center justify-end gap-2">
              {problem || add.error ? (
                <span className="mr-auto text-xs text-destructive-foreground">
                  {problem ??
                    (add.error instanceof Error ? add.error.message : "Couldn’t add the key.")}
                </span>
              ) : null}
              <Button
                size="sm"
                disabled={add.isPending || !value.trim()}
                onClick={() => {
                  const found = sshKeyProblem(value);
                  if (found) {
                    setProblem(found);
                    return;
                  }
                  add.mutate(value.trim());
                }}
                data-testid="own-ssh-add"
              >
                {add.isPending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                Add key
              </Button>
            </div>
          </>
        ) : (
          <div>
            <External href={CONSOLE_SSH_KEYS_URL}>
              <KeyRoundIcon className="size-3.5" />
              Open SSH keys
            </External>
          </div>
        )}
      </div>
      <details className="rounded-xl border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm">No key yet? Make one in a minute</summary>
        <div className="mt-2 flex flex-col gap-2 text-muted-foreground">
          <p>On your Mac or PC, open Terminal and run:</p>
          <Code value="ssh-keygen -t ed25519" label="Command" />
          <p>Press Enter for every question. Then copy your public key and paste it above:</p>
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
