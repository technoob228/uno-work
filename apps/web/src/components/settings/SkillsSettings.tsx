import { SkillsPanel } from "../setup/steps/SkillsStep";
import { SettingsPageContainer } from "./settingsLayout";

export function SkillsSettings() {
  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-1 px-1" data-testid="settings-skills">
        <h1 className="text-lg font-semibold">Skills</h1>
        <p className="text-sm text-muted-foreground">
          A skill is a short playbook for one kind of task. Add it once, and your AI uses it when it
          fits. Changes apply to new chats.
        </p>
      </div>
      <div>
        <SkillsPanel />
      </div>
    </SettingsPageContainer>
  );
}
