import type { BrowserBridgeRequestContext, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { normalizeProjectPathForComparison } from "../../lib/projectPaths";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "../../logicalProject";
import type { AppState } from "../../store";
import type { Project } from "../../types";

/**
 * Маршрутизация bridge-событий: по контексту запроса (threadId и/или cwd
 * харнесса) находит логический ключ проекта, чтобы вкладка открылась в своём
 * проекте, а не в том, который сейчас на экране. null — контекст пуст или не
 * сопоставился ни с одним известным проектом (вызывающий решает fallback).
 */
export function resolveBridgeEventProjectKey(input: {
  context: BrowserBridgeRequestContext | undefined;
  environmentId: EnvironmentId;
  state: AppState;
  groupingSettings: ProjectGroupingSettings;
}): string | null {
  const { context } = input;
  if (!context) return null;
  const environmentState = input.state.environmentStateById[input.environmentId];
  if (!environmentState) return null;

  const projectKeyOf = (project: Project) =>
    deriveLogicalProjectKeyFromSettings(project, input.groupingSettings);

  if (context.threadId) {
    const shell = environmentState.threadShellById[context.threadId as ThreadId];
    const project = shell ? environmentState.projectById[shell.projectId] : undefined;
    if (project) return projectKeyOf(project);
  }

  const normalizedCwd = context.cwd ? normalizeProjectPathForComparison(context.cwd) : "";
  if (normalizedCwd.length === 0) return null;

  const isWithin = (root: string) =>
    root.length > 0 &&
    (normalizedCwd === root ||
      normalizedCwd.startsWith(`${root}/`) ||
      normalizedCwd.startsWith(`${root}\\`));

  // Харнесс может сидеть глубже корня проекта (или в worktree треда), поэтому
  // сравниваем по префиксу и берём самое длинное совпадение.
  let best: { project: Project; rootLength: number } | null = null;
  const consider = (project: Project | undefined, root: string) => {
    if (!project || !isWithin(root)) return;
    if (!best || root.length > best.rootLength) {
      best = { project, rootLength: root.length };
    }
  };

  for (const projectId of environmentState.projectIds) {
    const project = environmentState.projectById[projectId];
    if (!project) continue;
    consider(project, normalizeProjectPathForComparison(project.cwd));
  }
  for (const threadId of environmentState.threadIds) {
    const shell = environmentState.threadShellById[threadId];
    if (!shell?.worktreePath) continue;
    consider(
      environmentState.projectById[shell.projectId],
      normalizeProjectPathForComparison(shell.worktreePath),
    );
  }

  return best ? projectKeyOf((best as { project: Project }).project) : null;
}
