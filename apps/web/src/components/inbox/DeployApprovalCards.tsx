/**
 * Deploy-window requests at the top of the Inbox (the sidebar's list, the
 * rail's "Needs you", the bell): a separate kind of entry — they come from
 * the console's ops gate, not from a computer's Inbox (deployApprovals/).
 *
 * A waiting request: what is shipped, which machine asks, for how long —
 * «Открыть на N мин» (the console's Touch ID page in the browser) and
 * «Отказать». An open window: «Закрыть сейчас». And «Заморозить всё» for
 * the whole gate. Decided ones stay for a while with the console's own line.
 */
import {
  ExternalLinkIcon,
  LockKeyholeOpenIcon,
  ShieldAlertIcon,
  SnowflakeIcon,
} from "lucide-react";
import { memo, useState } from "react";

import {
  type DeployCardAction,
  type DeployRequest,
  deployCardView,
  openUnavailableHint,
  visibleRequests,
} from "../../deployApprovals/deployApprovals.logic";
import {
  closeDeployWindow,
  denyDeployRequest,
  freezeDeploys,
  openDeployApprovalPage,
  useDeployApprovalsStore,
} from "../../deployApprovals/deployApprovalsStore";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

export const DeployApprovalCards = memo(function DeployApprovalCards(props: {
  /** "Needs you" lists: only what waits or is open now. */
  readonly liveOnly?: boolean;
  readonly className?: string;
}) {
  const gate = useDeployApprovalsStore((state) => state.gate);
  const busy = useDeployApprovalsStore((state) => state.busy);
  // Re-render every minute: "осталось N мин" and windows running out.
  useMinuteClock();
  const nowMs = Date.now();
  const requests = visibleRequests(gate, nowMs, props.liveOnly ? 0 : 3);
  if (!gate?.approver || requests.length === 0) return null;
  const hint = openUnavailableHint(gate);
  const anyLive = requests.some((q) => deployCardView(q, nowMs, gate).tone !== "done");

  return (
    <section
      aria-label="Окна в прод"
      className={cn("flex flex-col gap-1 px-1 pb-1.5", props.className)}
      data-testid="deploy-approvals"
    >
      <div className="flex h-6 items-center gap-1 pl-1">
        <span className="flex-1 text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
          Окна в прод
        </span>
        {gate.frozen ? (
          <span className="inline-flex items-center gap-1 pr-1 text-[11px] text-info">
            <SnowflakeIcon className="size-3" />
            Всё заморожено
          </span>
        ) : anyLive ? (
          <FreezeButton busy={busy.freeze === true} />
        ) : null}
      </div>
      <ul className="flex flex-col gap-1">
        {requests.map((request) => (
          <DeployCard
            key={request.id}
            request={request}
            nowMs={nowMs}
            gate={gate}
            busy={busy[String(request.id)] === true}
          />
        ))}
      </ul>
      {hint ? (
        <p className="px-1 text-[11px] leading-snug text-muted-foreground/80">{hint}</p>
      ) : null}
    </section>
  );
});

function DeployCard(props: {
  request: DeployRequest;
  nowMs: number;
  gate: Parameters<typeof deployCardView>[2];
  busy: boolean;
}) {
  const view = deployCardView(props.request, props.nowMs, props.gate);
  const Icon = view.tone === "open" ? LockKeyholeOpenIcon : ShieldAlertIcon;
  const press = (action: DeployCardAction) => {
    if (action === "open") openDeployApprovalPage(props.request);
    else if (action === "deny") void denyDeployRequest(props.request);
    else void closeDeployWindow(props.request);
  };
  return (
    <li
      className={cn(
        "list-none rounded-lg border px-2.5 py-2",
        view.tone === "waiting" && "border-warning/40 bg-warning/5",
        view.tone === "open" && "border-destructive/40 bg-destructive/5",
        view.tone === "done" && "border-border/60 opacity-75",
      )}
      data-testid={`deploy-card-${props.request.id}`}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            view.tone === "waiting" && "text-warning",
            view.tone === "open" && "text-destructive",
            view.tone === "done" && "text-muted-foreground",
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{view.title}</span>
          <span className="line-clamp-3 text-xs leading-snug break-words text-foreground/80">
            {view.summary}
          </span>
          <span className="text-[11px] text-muted-foreground/80">{view.meta}</span>
        </div>
      </div>
      {view.actions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 pt-2 pl-6">
          {view.actions.map((action) =>
            action === "open" ? (
              <Button
                key={action}
                size="xs"
                disabled={props.busy}
                onClick={() => press(action)}
                title="Откроется страница консоли — подтвердите Touch ID"
              >
                {view.openLabel}
                <ExternalLinkIcon />
              </Button>
            ) : action === "deny" ? (
              <Button
                key={action}
                size="xs"
                variant="outline"
                disabled={props.busy}
                onClick={() => press(action)}
              >
                Отказать
              </Button>
            ) : (
              <Button
                key={action}
                size="xs"
                variant="destructive-outline"
                disabled={props.busy}
                onClick={() => press(action)}
              >
                Закрыть сейчас
              </Button>
            ),
          )}
        </div>
      ) : null}
    </li>
  );
}

function FreezeButton({ busy }: { busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>
        <SnowflakeIcon />
        Заморозить всё
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[11px] text-muted-foreground">Закрыть окна и отказать всем?</span>
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={busy}
        onClick={() => {
          setConfirming(false);
          void freezeDeploys();
        }}
      >
        Да
      </Button>
      <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
        Нет
      </Button>
    </span>
  );
}
