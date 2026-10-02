/**
 * The first message of a chat continued from Uno AI (`handoffPrompt`): a
 * card with the goal and the sites Uno AI already put live — each with its
 * address, Open and "Saved to Sites" — instead of a wall of text where the
 * site was one line. The whole message stays one click away.
 */
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, GlobeIcon, SparklesIcon } from "lucide-react";
import { memo, useState } from "react";

import { openInNewTab } from "../../navigation/useOpenApp";
import { describeUnoAiHandoff } from "../../unoai/unoAiHandoff";
import { Button } from "../ui/button";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const UnoAiHandoffCard = memo(function UnoAiHandoffCard(props: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const summary = describeUnoAiHandoff(props.text);
  const ToggleIcon = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="flex flex-col gap-2" data-testid="uno-ai-handoff">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <SparklesIcon className="size-3.5 shrink-0 text-primary" />
        Continued from Uno AI
      </div>
      {summary.goal ? (
        <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
          {summary.goal}
        </div>
      ) : null}
      {summary.sites.map((site) => (
        <div
          key={site.url}
          className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border/80 bg-background/70 px-3 py-2"
          data-testid="uno-ai-handoff-site"
        >
          <GlobeIcon className="size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-foreground">
              {site.title ?? hostOf(site.url)}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="truncate">{hostOf(site.url)}</span>
              <span aria-hidden>·</span>
              <button
                type="button"
                className="shrink-0 underline-offset-2 hover:text-foreground hover:underline"
                title="See all your sites"
                onClick={() => void navigate({ to: "/my-uno", search: { section: "sites" } })}
              >
                Saved to Sites
              </button>
            </div>
          </div>
          <Button size="xs" variant="outline" onClick={() => openInNewTab(site.url)}>
            <ExternalLinkIcon />
            Open
          </Button>
        </div>
      ))}
      <button
        type="button"
        className="flex w-fit items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <ToggleIcon className="size-3 shrink-0" />
        {expanded ? "Hide what Uno was told" : "Show what Uno was told"}
      </button>
      {expanded ? (
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-background/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {props.text}
        </div>
      ) : null}
    </div>
  );
});
