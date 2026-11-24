/**
 * A deploy-window request opened from its system notification (T68, Misha
 * 24.11: "I click the notification and it loads for 3 seconds — it must be
 * instant"). Before, the click only switched the sidebar to the Inbox — which
 * the standard layout reads as Chats, so the card didn't open at all and the
 * person went looking for it in the bell. Now the click shows this dialog
 * over whatever is on screen, drawn from the request the notification was
 * made from (deployApprovalsStore `focused`): no route, no chat, no sidebar
 * and no console round trip before the buttons are there. The console's
 * fresh answer replaces the copy as soon as it arrives.
 */
import { memo } from "react";

import {
  closeDeployFocus,
  useDeployApprovalsStore,
  useFocusedDeployRequest,
} from "../../deployApprovals/deployApprovalsStore";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { DeployCard } from "./DeployApprovalCards";

export const DeployRequestDialog = memo(function DeployRequestDialog() {
  const request = useFocusedDeployRequest();
  const gate = useDeployApprovalsStore((state) => state.gate);
  const busy = useDeployApprovalsStore((state) =>
    request ? state.busy[String(request.id)] === true : false,
  );
  useMinuteClock();
  if (!request || !gate?.approver) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeDeployFocus();
      }}
    >
      <DialogPopup className="max-w-md p-4 pt-3" data-testid="deploy-request-dialog">
        <DialogTitle className="pr-8 pb-2 text-sm font-semibold">Окно в прод</DialogTitle>
        <DeployCard
          as="div"
          request={request}
          nowMs={Date.now()}
          gate={gate}
          busy={busy}
          onPressed={closeDeployFocus}
        />
      </DialogPopup>
    </Dialog>
  );
});
