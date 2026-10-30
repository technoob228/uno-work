/**
 * The computer chip outside Home — today the chat header: the same chip and
 * menu as Home's header (this computer, economy and Boost lines, the
 * computers to switch to, All computers, Add computer), folded for a header
 * that already has the chat's own actions. It is about the open chat's
 * computer, whichever one Home has picked: in a chat, everything is on its
 * computer.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useNameAmongComputers } from "../../computerSwitcher/useComputerSwitcher";
import { ComputerPill } from "./ComputerPill";
import { useHomeComputer } from "./useHomeComputer";

export function ComputerChip({ environmentId }: { environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const computerName = useNameAmongComputers(environmentId);
  const home = useHomeComputer({
    environmentId,
    boxId: null,
    onOpenLook: (look) => void navigate({ to: "/computer", search: { look } }),
  });
  return (
    <>
      <ComputerPill
        computer={home.homeComputer}
        loading={home.stateQuery.isLoading || home.nameLoading}
        fit="chat"
        environmentId={environmentId}
        namesChatComputer={computerName !== null}
      />
      {home.dialogs}
    </>
  );
}
