/**
 * "Automation created · When … · Open" in the chat: what an assistant's
 * `automation_create` call made, from the call's own result — not from what
 * the assistant chose to say.
 */
import { type Automation, describeAutomationTrigger } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";

import { Button } from "../ui/button";

export function AutomationCreatedCard(props: { readonly automation: Automation }) {
  const { automation } = props;
  const navigate = useNavigate();
  return (
    <div
      className="my-1 flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2"
      data-testid="automation-created-card"
      data-automation={automation.id}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-amber-400 to-orange-600 text-white">
        <WorkflowIcon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-muted-foreground">Automation created</span>
        <span className="truncate text-sm font-medium">{automation.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {describeAutomationTrigger(automation.trigger)}
        </span>
      </span>
      <Button
        size="xs"
        variant="outline"
        onClick={() => void navigate({ to: "/automations", search: { id: automation.id } })}
        data-testid="automation-created-open"
      >
        Open
      </Button>
    </div>
  );
}
