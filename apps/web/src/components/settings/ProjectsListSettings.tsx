/**
 * Settings → Projects: the way into a project's settings (all computers,
 * versions, people, keys) that doesn't depend on the sidebar: One list and By
 * status have no project rows to open them from. A project on several
 * computers gets a button per computer, as its sidebar menu asks which one.
 *
 * @module components/settings/ProjectsListSettings
 */
import { useState } from "react";

import {
  ProjectSettingsDialog,
  type ProjectSettingsTarget,
} from "../projectSync/ProjectSettingsDialog";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export function ProjectsListSettings() {
  const { groups } = useSettingsScope();
  const [target, setTarget] = useState<ProjectSettingsTarget | null>(null);
  return (
    <SettingsPageContainer>
      <SettingsSection title="Projects">
        {groups.length === 0 ? (
          <SettingsRow title="No projects" description="Projects you add show up here." />
        ) : (
          groups.map((group) => {
            const several = group.memberProjects.length > 1;
            return (
              <SettingsRow
                key={group.projectKey}
                title={group.displayName}
                description={several ? `On ${group.memberProjects.length} computers` : group.cwd}
                control={
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {group.memberProjects.map((member) => (
                      <Button
                        key={member.physicalProjectKey}
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          setTarget({
                            environmentId: member.environmentId,
                            projectId: member.id,
                            name: member.name,
                            cwd: member.cwd,
                          })
                        }
                      >
                        {several ? (member.environmentLabel ?? member.environmentId) : "Settings"}
                      </Button>
                    ))}
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>
      <ProjectSettingsDialog target={target} onClose={() => setTarget(null)} />
    </SettingsPageContainer>
  );
}
