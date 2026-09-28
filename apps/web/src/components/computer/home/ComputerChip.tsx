/**
 * The computer chip outside Home — today the chat header: the same chip and
 * menu as Home's header (this computer, economy and Boost lines, the
 * computers to switch to, All computers, Add computer), folded for a header
 * that already has the chat's own actions.
 */
import { useNavigate } from "@tanstack/react-router";

import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useStore } from "../../../store";
import { ComputerPill } from "./ComputerPill";
import { useHomeComputer } from "./useHomeComputer";

export function ComputerChip() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const navigate = useNavigate();
  const home = useHomeComputer({
    // The computer Home shows: the one picked in the switcher.
    environmentId: activeEnvironmentId ?? primaryEnvironmentId,
    boxId: null,
    onOpenLook: (look) => void navigate({ to: "/computer", search: { look } }),
  });
  return (
    <>
      <ComputerPill computer={home.homeComputer} loading={home.stateQuery.isLoading} fit="chat" />
      {home.dialogs}
    </>
  );
}
