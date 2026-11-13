/**
 * The developer way, step 2 — import projects from my computer (13.11): the
 * Add computer window's own-computer flow inside the page
 * (`ImportFromComputer`). Bring starts the copy on the cloud computer and
 * moves on at once: the next step shows each project copying, then ready.
 * What was picked is kept in the setup's answers (`withPicks`), so a reload or
 * another device still knows which projects are on their way.
 */
import { ImportFromComputer, useImportFromComputer } from "../ImportFromComputer";
import { withPicks } from "../devSetup";
import { SetupShell } from "../SetupShell";
import { useSetupNavigation } from "../useSetupNavigation";
import { useUpdateSetupProgress } from "../useSetupProgress";

export function DevImportStep() {
  const flow = useImportFromComputer();
  const { choice } = flow;
  const update = useUpdateSetupProgress();
  const { completeStep } = useSetupNavigation();

  const bring = async () => {
    const computerId = flow.computerId;
    if (computerId === null) return;
    const started = await choice.bring();
    if (!started) return;
    await update((current) => withPicks(current, computerId, started.projects));
    void completeStep("import");
  };

  return (
    <SetupShell
      step="import"
      primary={
        flow.phase === "bring"
          ? {
              label: choice.label === "" ? "Bring" : `Bring ${choice.label}`,
              disabled: choice.label === "",
              pending: choice.busy,
              onClick: () => void bring(),
            }
          : null
      }
    >
      <ImportFromComputer flow={flow} />
    </SetupShell>
  );
}
