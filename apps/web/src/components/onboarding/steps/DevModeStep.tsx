import { GitBranch, Play, SplitSquareHorizontal, TerminalSquare } from "lucide-react";

import { Switch } from "../../ui/switch";
import { setDevMode, useDevMode } from "~/devMode";
import {
  FeatureBullet,
  StepEyebrow,
  StepLead,
  StepScreenshot,
  StepTitle,
  TwoColumn,
} from "./stepShared";

export function DevModeStep() {
  const devMode = useDevMode();

  return (
    <TwoColumn screenshotEmphasis>
      <div>
        <StepEyebrow>For coders</StepEyebrow>
        <StepTitle>Coding? Turn on Dev mode.</StepTitle>
        <StepLead>
          Dev mode unlocks tools designed for software work. Hidden by default to keep the
          interface clean for non-coders.
        </StepLead>
        <ul className="mt-6 grid gap-3">
          <FeatureBullet icon={<GitBranch className="size-3.5" />}>
            <b>Git, GitHub &amp; GitLab</b> — branches, commits, push, PRs.
          </FeatureBullet>
          <FeatureBullet icon={<SplitSquareHorizontal className="size-3.5" />}>
            <b>Diff review</b> — see every file the agent changed before accepting.
          </FeatureBullet>
          <FeatureBullet icon={<Play className="size-3.5" />}>
            <b>Project scripts</b> — run npm/bun/cargo/make from the chat header.
          </FeatureBullet>
          <FeatureBullet icon={<TerminalSquare className="size-3.5" />}>
            <b>Terminal access</b> — drop into a shell inside the project.
          </FeatureBullet>
        </ul>
        <label className="mt-6 inline-flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 cursor-pointer">
          <Switch checked={devMode} onCheckedChange={setDevMode} />
          <span className="text-sm">
            <b>Enable Dev mode</b> — toggle any time from chat header.
          </span>
        </label>
      </div>
      <StepScreenshot src="/onboarding/devmode.png" alt="Dev mode and diff view" variant="dark" />
    </TwoColumn>
  );
}
