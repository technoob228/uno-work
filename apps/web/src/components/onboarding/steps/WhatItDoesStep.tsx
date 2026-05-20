import { Eye, FileText, MonitorCog, TerminalSquare } from "lucide-react";

import {
  FeatureBullet,
  StepEyebrow,
  StepLead,
  StepScreenshot,
  StepTitle,
  TwoColumn,
} from "./stepShared";

export function WhatItDoesStep() {
  return (
    <TwoColumn screenshotEmphasis>
      <div>
        <StepEyebrow>What it can do</StepEyebrow>
        <StepTitle>Work on anything, not just code.</StepTitle>
        <StepLead>
          Uno Work isn't an IDE. It's a workspace where AI does real work on real files — and you
          can see the result without leaving the app.
        </StepLead>
        <ul className="mt-6 grid gap-3">
          <FeatureBullet icon={<FileText className="size-3.5" />}>
            <b>Create &amp; edit any files</b> — docs, spreadsheets, presentations, configs.
          </FeatureBullet>
          <FeatureBullet icon={<TerminalSquare className="size-3.5" />}>
            <b>Write and run code</b> — scripts, web apps, automations.
          </FeatureBullet>
          <FeatureBullet icon={<MonitorCog className="size-3.5" />}>
            <b>Manage servers</b> — SSH, deploys, log inspection, restarts.
          </FeatureBullet>
          <FeatureBullet icon={<Eye className="size-3.5" />}>
            <b>Preview results inline</b> — PDF, Excel, Word, HTML, images, JSON.
          </FeatureBullet>
        </ul>
      </div>
      <StepScreenshot src="/onboarding/preview.png" alt="Chat and preview pane" />
    </TwoColumn>
  );
}
