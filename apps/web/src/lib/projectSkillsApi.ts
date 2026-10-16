/**
 * Skills that live in the person's projects (a `SKILL.md` in the project's
 * `.claude/skills/<name>/` or `skills/<name>/`), as the teammate's access
 * lists them (track 3, 16.10). New route on the daemon: an older one answers
 * 404 and the list reads "No skills in your projects yet".
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { environmentFetchJson } from "~/environments/http/target";

export interface ProjectSkill {
  readonly name: string;
  readonly project: string;
  /** Path inside the project. */
  readonly path: string;
  readonly description: string;
}

export function listProjectSkills(input: {
  readonly environmentId: EnvironmentId;
}): Promise<{ readonly skills: ReadonlyArray<ProjectSkill> }> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: "/api/manager/project-skills",
  });
}
