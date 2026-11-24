/**
 * What a failed agent install shows. When the daemon could not finish by
 * itself (no Node.js on the machine and none could be fetched, T64) it sends
 * `help`: a plain cause, the command for this machine with a Copy button, the
 * vendor's install page, and Check again — never a bare "not on PATH".
 *
 * @module components/harness/InstallFailureCard
 */
import { Check, Copy, ExternalLink, TriangleAlert } from "lucide-react";
import { useState } from "react";

import type { ProviderInstallJobStatus } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SetupLogDetails } from "./SetupLogDetails";

function ExternalTextLink(props: { href: string; children: string }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 self-start text-xs font-medium text-primary underline-offset-2 hover:underline"
    >
      {props.children}
      <ExternalLink className="size-3" />
    </a>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-border bg-background">
      <code className="min-w-0 flex-1 px-2 py-1.5 font-mono text-[11px] leading-relaxed break-all select-all">
        {command}
      </code>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy command"}
        onClick={() =>
          void navigator.clipboard
            ?.writeText(command)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
        className="flex shrink-0 items-center gap-1 border-l border-border px-2 text-[11px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function InstallFailureCard(props: {
  readonly job: ProviderInstallJobStatus | undefined;
  readonly onRetry: () => void;
  readonly onCheckAgain: () => void;
  readonly className?: string;
}) {
  const { job } = props;
  const help = job?.help;

  if (!help) {
    return (
      <div
        className={cn(
          "flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5",
          props.className,
        )}
      >
        <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{job?.error ?? "The install failed."}</span>
        </div>
        <SetupLogDetails log={job?.log ?? ""} label="Show log" />
        <Button size="sm" variant="outline" className="self-start" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5",
        props.className,
      )}
      data-install-help="true"
    >
      <div className="flex items-start gap-2 text-xs font-medium text-amber-700 dark:text-amber-300">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{help.title}</span>
      </div>
      {help.detail ? (
        <p className="text-xs leading-snug text-muted-foreground">{help.detail}</p>
      ) : null}
      {help.nodeUrl ? (
        <ExternalTextLink href={help.nodeUrl}>Download Node.js</ExternalTextLink>
      ) : null}
      {help.command ? (
        <div className="flex flex-col gap-1">
          <CopyCommand command={help.command} />
          {help.commandNote ? (
            <span className="text-[11px] leading-snug text-muted-foreground">
              {help.commandNote}
            </span>
          ) : null}
        </div>
      ) : null}
      {help.docsUrl ? (
        <ExternalTextLink href={help.docsUrl}>{help.docsLabel ?? "Install guide"}</ExternalTextLink>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="self-start" onClick={props.onCheckAgain}>
          Check again
        </Button>
        <Button size="sm" variant="outline" className="self-start" onClick={props.onRetry}>
          Try install again
        </Button>
      </div>
      <SetupLogDetails log={job?.log ?? ""} label="Show log" />
    </div>
  );
}
