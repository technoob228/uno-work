import { useSettings } from "../../hooks/useSettings";
import { RemoteImagesOffContext } from "../ChatMarkdown";
import PlanPanel from "../PlanPanel";
import { threadIdFromTasksFile, type PreviewFile } from "./PreviewPaneContext";
import { useThreadTasks } from "./tasksTabStore";

/**
 * Тело вкладки «Tasks/Plan»: план треда, который опубликовал его ChatView
 * (`tasksTabStore`). Пока снимка нет (чат ещё грузится) — пустое состояние
 * самой PlanPanel.
 */
export function TasksTabBody({ file }: { file: PreviewFile }) {
  const threadId = threadIdFromTasksFile(file);
  const snapshot = useThreadTasks(threadId);
  const timestampFormat = useSettings((settings) => settings.timestampFormat);
  const environmentId = snapshot?.environmentId ?? file.environmentId;
  if (!environmentId) return null;
  return (
    // Outside the chat's tree: a plan needs no remote image in any chat.
    <RemoteImagesOffContext.Provider value={true}>
      <PlanPanel
        activePlan={snapshot?.activePlan ?? null}
        activeProposedPlan={snapshot?.proposedPlan ?? null}
        label={snapshot?.label ?? file.name}
        environmentId={environmentId}
        markdownCwd={snapshot?.markdownCwd}
        workspaceRoot={snapshot?.workspaceRoot}
        timestampFormat={timestampFormat}
      />
    </RemoteImagesOffContext.Provider>
  );
}

/** Название вкладки идёт за режимом треда: "Plan" ↔ "Tasks". */
export function TasksTabName({ file }: { file: PreviewFile }) {
  const snapshot = useThreadTasks(threadIdFromTasksFile(file));
  return <>{snapshot?.label ?? file.name}</>;
}
