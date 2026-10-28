/**
 * When the sidebar shows the big "Add a project" button under the chats bar
 * (Misha 28.10): a new account had an empty sidebar under "All chats", and
 * the only way to add a project was the small folder icon nobody saw.
 *
 * It counts the person's own projects only: the assistant's folder (Uno) and
 * the computer's home folder are always there and are not projects. Chats
 * without a project do not matter — the button goes once one project exists.
 */
import { isAssistantProjectId } from "@t3tools/contracts";

export function countOwnProjects<P extends { readonly id: string }>(
  projects: ReadonlyArray<P>,
  isHomeFolder: (project: P) => boolean,
): number {
  let count = 0;
  for (const project of projects) {
    if (isAssistantProjectId(project.id) || isHomeFolder(project)) continue;
    count += 1;
  }
  return count;
}

export function showSidebarAddProject(input: {
  /** The person's own projects (countOwnProjects). */
  readonly ownProjectCount: number;
  /** The computer hasn't sent its list yet: unknown is not empty. */
  readonly loading: boolean;
  /** The setup's Project step is naming one right now (the sidebar previews it). */
  readonly projectBeingSetUp: boolean;
}): boolean {
  return input.ownProjectCount === 0 && !input.loading && !input.projectBeingSetUp;
}
