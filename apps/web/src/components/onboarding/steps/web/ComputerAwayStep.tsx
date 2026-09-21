import { Globe, HardDrive, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { StepEyebrow, StepLead, StepTitle } from "../stepShared";

function AwayCard({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof HardDrive;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-card p-5 text-left">
      <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-4.5" />
      </span>
      <span className="text-sm font-semibold">{title}</span>
      <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * Second onboarding screen: why having your own computer (rather than a chat
 * window) matters — it keeps existing, and working, while you are gone.
 */
export function ComputerAwayStep() {
  return (
    <div className="m-auto w-full max-w-3xl">
      <StepEyebrow>Always on</StepEyebrow>
      <StepTitle>It keeps working while you&apos;re away</StepTitle>
      <StepLead>
        This computer does not live in your browser tab. Close the tab, shut your laptop — it stays
        on, holds onto your files, and finishes what you started.
      </StepLead>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        <AwayCard icon={HardDrive} title="Your files stay put">
          Everything you and the AI make is saved on this computer&apos;s disk. Come back tomorrow —
          or next month — and it&apos;s all still here.
        </AwayCard>
        <AwayCard icon={Globe} title="Your apps get an address">
          Run a website, a bot, or an API here and it can be reached at its own link — even while
          your laptop is off.
        </AwayCard>
        <AwayCard icon={Sparkles} title="The AI lives here">
          The agent runs on this computer, not in your browser. Hand it a long task, walk away, and
          check the result later.
        </AwayCard>
      </div>
    </div>
  );
}
