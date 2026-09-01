import { FlaskConicalIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/**
 * Shown in place of a settings panel whose feature flag is turned off. Keeps
 * the panel reachable by URL (so nothing 404s) but renders no live feature
 * surface, and points the user at Labs to turn it back on.
 */
export function FeatureDisabledPanel({ feature }: { feature: string }) {
  const navigate = useNavigate();
  return (
    <SettingsPageContainer>
      <SettingsSection title={feature}>
        <Empty className="min-h-88">
          <EmptyMedia variant="icon">
            <FlaskConicalIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{feature} is turned off</EmptyTitle>
            <EmptyDescription>
              This feature is disabled by a Labs flag. Enable it in Settings → Labs to use it.
            </EmptyDescription>
          </EmptyHeader>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: "/settings/app/labs" })}
          >
            Open Labs
          </Button>
        </Empty>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
