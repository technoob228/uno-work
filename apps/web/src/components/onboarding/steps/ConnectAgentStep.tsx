import { ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { CopyButton } from "../../computer/computerUi";
import { Button } from "../../ui/button";
import { openInstallDocs } from "../harnessInstallLinks";
import { StepTitle } from "./stepShared";

/** Where an API key for an agent lives today: console → Secrets → API keys. */
export const CONSOLE_API_KEYS_URL = "https://console.uno4.dev/secrets?tab=tokens";

type AgentTarget = "claude-code" | "desktop" | "web";

const CLAUDE_CODE_COMMAND = "claude mcp add uno --env UNO_API_KEY=YOUR_KEY -- npx -y @uno4/mcp";

const DESKTOP_CONFIG = `{
  "mcpServers": {
    "uno": {
      "command": "npx",
      "args": ["-y", "@uno4/mcp"],
      "env": { "UNO_API_KEY": "YOUR_KEY" }
    }
  }
}`;

const TARGETS: ReadonlyArray<{ id: AgentTarget; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "desktop", label: "Claude Desktop · Cursor" },
  { id: "web", label: "Claude.ai · ChatGPT" },
];

function StepNumber({ n }: { n: number }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
      {n}
    </span>
  );
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="relative mt-2 rounded-xl border border-border bg-muted/40">
      <pre className="overflow-x-auto p-3 pr-20 font-mono text-xs leading-relaxed whitespace-pre">
        {code}
      </pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton value={code} label={label} />
      </div>
    </div>
  );
}

/**
 * "With my own AI agent": connect Claude Code / Claude Desktop / Cursor to Uno
 * through the published MCP server (`@uno4/mcp`). The key is made in the
 * console, where keys already live — onboarding never mints or shows one.
 * Claude.ai and ChatGPT need a hosted MCP with "Sign in with Uno", which
 * does not exist yet, so they say so honestly.
 */
export function ConnectAgentStep() {
  const [target, setTarget] = useState<AgentTarget>("claude-code");

  return (
    <div className="m-auto flex w-full max-w-2xl flex-col gap-6">
      <div>
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
          Your own agent
        </div>
        <StepTitle>Connect your agent</StepTitle>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-muted-foreground">
          Three steps, once. After that your agent can make computers, sites and storage on your
          Uno account for you.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Where your agent lives"
        className="inline-flex w-fit flex-wrap gap-1 rounded-xl border border-border bg-muted/40 p-1"
      >
        {TARGETS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={target === item.id}
            onClick={() => setTarget(item.id)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm transition",
              target === item.id
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
            {item.id === "web" ? (
              <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                Soon
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {target === "web" ? (
        <div className="rounded-2xl border border-dashed border-border p-5 text-sm leading-relaxed">
          <div className="font-medium">Coming soon</div>
          <p className="mt-1 text-muted-foreground">
            Soon you&apos;ll add Uno in Claude.ai or ChatGPT as a connector and sign in with your
            Uno account — no keys to copy. Until then, use Claude Code, Claude Desktop or Cursor:
            they connect today.
          </p>
        </div>
      ) : (
        <ol className="flex flex-col gap-5">
          <li className="flex gap-3">
            <StepNumber n={1} />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">Make a key for your agent</div>
              <p className="mt-1 text-muted-foreground">
                In the Uno console, under API keys. Give it its own key — you can switch it off
                any time without touching anything else.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2.5"
                onClick={() => openInstallDocs(CONSOLE_API_KEYS_URL)}
              >
                <KeyRoundIcon className="size-3.5" />
                Open API keys
                <ExternalLinkIcon className="size-3 opacity-60" />
              </Button>
            </div>
          </li>
          <li className="flex gap-3">
            <StepNumber n={2} />
            <div className="min-w-0 flex-1 text-sm">
              {target === "claude-code" ? (
                <>
                  <div className="font-medium">Add Uno to Claude Code</div>
                  <p className="mt-1 text-muted-foreground">
                    Paste this in your terminal and put your key in place of YOUR_KEY.
                  </p>
                  <CodeBlock code={CLAUDE_CODE_COMMAND} label="Claude Code command" />
                </>
              ) : (
                <>
                  <div className="font-medium">Add Uno to the app&apos;s MCP settings</div>
                  <p className="mt-1 text-muted-foreground">
                    Claude Desktop: Settings → Developer → Edit config. Cursor: Settings → MCP. Put
                    your key in place of YOUR_KEY, then restart the app.
                  </p>
                  <CodeBlock code={DESKTOP_CONFIG} label="MCP config" />
                </>
              )}
            </div>
          </li>
          <li className="flex gap-3">
            <StepNumber n={3} />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">Just ask</div>
              <p className="mt-1 text-muted-foreground">
                &ldquo;Put this page online on Uno.&rdquo; &ldquo;Make me a small server for my
                bot.&rdquo; Your agent does the rest.
              </p>
            </div>
          </li>
        </ol>
      )}

      <p className="text-xs text-muted-foreground/80">
        Uno Work stays here too — open it whenever you want to see your computers and files.
      </p>
    </div>
  );
}
