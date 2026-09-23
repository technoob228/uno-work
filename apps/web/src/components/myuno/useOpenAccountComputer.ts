/**
 * "Open" on an Uno Work computer from My Uno: the same path as the sidebar's
 * computer switcher — a computer this app already talks to is switched to,
 * any other one is woken, connected and then opened on its Home.
 */
import { useCallback, useState } from "react";

import type { AccountComputer } from "../../account/accountOverview";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useMachineRows } from "../../hooks/useMachineRows";
import { useSwitchEnvironment } from "../../hooks/useSwitchEnvironment";
import { connectUnoBox, describeUnoBoxConnectProgress } from "../../unoBoxConnect";
import { toastManager } from "../ui/toast";

export function useOpenAccountComputer() {
  const rows = useMachineRows();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const switchEnvironment = useSwitchEnvironment();
  const [opening, setOpening] = useState<{ id: number; label: string } | null>(null);

  const open = useCallback(
    async (computer: AccountComputer) => {
      const row = rows.find((candidate) => candidate.box?.id === computer.id);
      if (row?.environmentId) {
        switchEnvironment(row.environmentId, { landing: "computer" });
        return;
      }
      if (!primaryEnvironmentId || opening) return;
      setOpening({ id: computer.id, label: "Connecting…" });
      try {
        const record = await connectUnoBox(
          primaryEnvironmentId,
          { id: computer.id, name: computer.name, status: computer.status },
          {
            onProgress: (progress) =>
              setOpening({ id: computer.id, label: describeUnoBoxConnectProgress(progress) }),
          },
        );
        switchEnvironment(record.environmentId, { landing: "computer" });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Couldn't open ${computer.name}`,
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setOpening(null);
      }
    },
    [opening, primaryEnvironmentId, rows, switchEnvironment],
  );

  /** The environment this app already has for a computer, if any. */
  const environmentFor = useCallback(
    (id: number) => rows.find((candidate) => candidate.box?.id === id)?.environmentId ?? null,
    [rows],
  );

  return { open, opening, environmentFor };
}
