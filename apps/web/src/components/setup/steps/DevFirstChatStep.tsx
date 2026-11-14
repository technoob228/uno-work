/**
 * The developer way, step 3 — open a chat in your project (13.11). The
 * projects picked on the import step, the first selected; each shows
 * "Copying…" until it is a project here, or why it didn't come over. Start
 * opens a new chat in the selected one on the agent picked in step 1, and the
 * project becomes the setup's project (Home: "Working on …").
 */
import { scopeProjectRef } from "@t3tools/client-runtime";
import { FolderGit2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { useComputersHostId } from "../../../computersLifecycle/useComputers";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { useHomeFolderPath } from "../../../hooks/useFolderChats";
import { useSettings } from "../../../hooks/useSettings";
import { useServerProviders } from "../../../rpc/serverState";
import { BroughtProjectList, useBroughtRows } from "../BroughtProjects";
import { DEV_AGENT_LABEL, devAgentSelection, parseDevAgent } from "../devAgent";
import {
  DEV_AGENT_KEY,
  DEV_COMPUTER_KEY,
  DEV_PROJECTS_KEY,
  decodePicks,
  selectedRow,
} from "../devSetup";
import { markCompleted, tildePath } from "../setupModel";
import { SetupHeading, SetupNote, SetupShell } from "../SetupShell";
import { useSetupNavigation } from "../useSetupNavigation";
import { useSetupProgress, useUpdateSetupProgress } from "../useSetupProgress";

export function DevFirstChatStep() {
  const progress = useSetupProgress();
  const update = useUpdateSetupProgress();
  const { goToStep } = useSetupNavigation();
  const hostId = useComputersHostId();
  const home = useHomeFolderPath(hostId);
  const providers = useServerProviders();
  const settings = useSettings();
  const { handleNewThread } = useNewThreadHandler();

  const computerId = progress.answers[DEV_COMPUTER_KEY] ?? null;
  const picksAnswer = progress.answers[DEV_PROJECTS_KEY];
  const picks = useMemo(() => decodePicks(picksAnswer), [picksAnswer]);
  const { rows } = useBroughtRows(computerId, picks);
  const [picked, setPicked] = useState<string | null>(null);
  const row = selectedRow(rows, picked);
  const agent = parseDevAgent(progress.answers[DEV_AGENT_KEY]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (row?.state.kind !== "ready" || hostId === null) return;
    const { projectId, folder } = row.state;
    setPending(true);
    setError(null);
    try {
      await update((current) =>
        markCompleted(
          { ...current, project: { id: projectId, path: folder, name: row.name, kind: "other" } },
          "first-chat",
        ),
      );
      const projectRef = scopeProjectRef(hostId, projectId);
      await handleNewThread(projectRef);
      // The agent picked in step 1, whatever new chats default to here.
      const selection = agent ? devAgentSelection(agent, providers, settings) : null;
      if (selection) {
        const store = useComposerDraftStore.getState();
        const draft = store.getDraftSessionByProjectRef(projectRef);
        if (draft) store.setModelSelection(draft.draftId, selection);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t open the chat. Try again.");
    } finally {
      setPending(false);
    }
  };

  const agentName = agent ? DEV_AGENT_LABEL[agent] : null;
  const label =
    row === null
      ? "Start a chat"
      : row.state.kind === "copying"
        ? `Copying ${row.name}…`
        : row.state.kind === "failed"
          ? "Pick another project"
          : `Start a chat in ${row.name}`;

  return (
    <SetupShell
      step="first-chat"
      primary={
        rows.length === 0
          ? { label: "Import projects", onClick: () => goToStep("import") }
          : {
              label,
              disabled: row?.state.kind !== "ready",
              pending,
              onClick: () => void start(),
            }
      }
    >
      <SetupHeading
        title="Open a chat in your project"
        lead={
          agentName ? (
            <>
              It starts on {agentName}, with the project’s files and keys here.{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => goToStep("sign-in")}
              >
                Change
              </button>
            </>
          ) : (
            "It starts with the project’s files and keys here."
          )
        }
      />
      {rows.length === 0 ? (
        <div
          className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border p-5 text-sm"
          data-testid="setup-brought-empty"
        >
          <FolderGit2Icon className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-muted-foreground">
            No projects on their way yet. Bring them from your laptop first.
          </p>
        </div>
      ) : (
        <BroughtProjectList
          rows={rows}
          selected={row?.path ?? null}
          onSelect={setPicked}
          shortPath={(folder) => tildePath(folder, home)}
        />
      )}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
      {rows.some((entry) => entry.state.kind === "copying") ? (
        <SetupNote>Copying goes on if you leave this page.</SetupNote>
      ) : null}
    </SetupShell>
  );
}
