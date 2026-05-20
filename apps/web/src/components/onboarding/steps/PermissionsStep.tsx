import { Eye, Hand, Settings2 } from "lucide-react";

import {
  FeatureBullet,
  StepEyebrow,
  StepLead,
  StepScreenshot,
  StepTitle,
  TwoColumn,
} from "./stepShared";

export function PermissionsStep() {
  return (
    <TwoColumn>
      <div>
        <StepEyebrow>You're in control</StepEyebrow>
        <StepTitle>You decide what the agent can do.</StepTitle>
        <StepLead>
          Every action the agent takes on your machine — reading files, editing them, running
          commands, accessing the internet — is something you can allow, deny, or be asked about.
        </StepLead>
        <ul className="mt-6 grid gap-3">
          <FeatureBullet icon={<Eye className="size-3.5" />}>
            <b>See what's about to happen</b> — the agent shows its plan before touching anything.
          </FeatureBullet>
          <FeatureBullet icon={<Hand className="size-3.5" />}>
            <b>Approve per action or per session</b> — switch modes depending on how much you trust
            the task.
          </FeatureBullet>
          <FeatureBullet icon={<Settings2 className="size-3.5" />}>
            <b>Tighten or loosen anytime</b> — ask the agent to configure the permission setup the
            way you want in the given harness.
          </FeatureBullet>
        </ul>
      </div>
      <StepScreenshot src="/onboarding/permissions.png" alt="Permissions UI" variant="contain" />
    </TwoColumn>
  );
}
