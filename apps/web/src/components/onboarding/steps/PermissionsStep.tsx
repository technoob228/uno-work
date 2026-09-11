import { Eye, Hand, Settings2 } from "lucide-react";

import { permissionModeLabel } from "../../../plainLanguage";
import { Explain } from "../../Explain";

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
        <StepTitle>
          <span className="inline-flex items-center gap-3">
            You decide what the agent can do.
            <Explain term="permissions" technical className="size-6 [&_svg]:size-5" />
          </span>
        </StepTitle>
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
            <b>Tighten or loosen anytime</b> — pick “{permissionModeLabel("approval-required")}”, “
            {permissionModeLabel("auto-accept-edits")}” or “{permissionModeLabel("full-access")}” in
            any chat, or ask the agent to set up finer rules.
          </FeatureBullet>
        </ul>
      </div>
      <StepScreenshot src="/onboarding/permissions.png" alt="Permissions UI" variant="contain" />
    </TwoColumn>
  );
}
