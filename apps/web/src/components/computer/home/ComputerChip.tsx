/**
 * The computer chip outside Home — today the chat header: the same chip and
 * menu as Home's header (this computer, economy and Boost lines, the
 * computers to switch to, All computers, Add computer), folded for a header
 * that already has the chat's own actions.
 */
import { useNavigate } from "@tanstack/react-router";

import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useStore } from "../../../store";
import { useProtoComputerInComposer } from "../../../proto/computerNames";
import { ComputerPill } from "./ComputerPill";
import { useHomeComputer } from "./useHomeComputer";

export function ComputerChip() {
  // Sidebar v2: with 2+ computers joined, a chat doesn't say "you are on X" on top.
  const hidden = useProtoComputerInComposer();
  if (hidden) return null;
  return <LiveComputerChip />;
}

function LiveComputerChip() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const navigate = useNavigate();
  // The computer Home shows: the one picked in the switcher.
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const home = useHomeComputer({
    environmentId,
    boxId: null,
    onOpenLook: (look) => void navigate({ to: "/computer", search: { look } }),
  });
  return (
    <>
      <ComputerPill
        computer={home.homeComputer}
        loading={home.stateQuery.isLoading}
        fit="chat"
        environmentId={environmentId}
      />
      {home.dialogs}
    </>
  );
}
