/**
 * Settings → Computer → "Chats from the cloud" (only on the person's own
 * computer): the switch that lets a chat on a cloud computer ask to start a
 * chat here (off until the person turns it on, Misha 20.11), and the
 * journal of the last requests — what was asked, by which chat, and what
 * became of it (started ones open their chat).
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import { type ChatRequestView, type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import {
  type ChatRequestTone,
  computerName,
  fromTitle,
  journalAt,
  journalEntries,
  journalTimeLabel,
  statusChip,
} from "../../chatRequests/chatRequests.logic";
import {
  setChatRequestsAllowed,
  useChatRequestsHostId,
  useChatRequestsStore,
} from "../../chatRequests/chatRequestsStore";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const CHIP_VARIANT: Record<ChatRequestTone, "warning" | "success" | "secondary" | "outline"> = {
  waiting: "warning",
  started: "success",
  declined: "secondary",
  ended: "outline",
};

/** The section, when the computer on screen is the one these requests come to. */
export function ChatRequestsSettingsSection(props: {
  readonly environmentId: EnvironmentId | null;
  readonly isCloud: boolean;
}) {
  const hostId = useChatRequestsHostId();
  const state = useChatRequestsStore((store) => store.state);
  const saving = useChatRequestsStore((store) => store.busy.allow === true);
  useMinuteClock();
  if (props.isCloud || !hostId || props.environmentId !== hostId) return null;
  const entries = journalEntries(state);
  const allow = state?.allow ?? false;

  return (
    <SettingsSection title="Chats from the cloud">
      <SettingsRow
        title="Allow cloud chats to ask to start chats here"
        description="A chat on your cloud computer can ask to start a chat on this computer. Nothing starts until you press Start, here or in your Telegram if it's connected to Uno Work. Off by default."
        status={
          !state
            ? null
            : state.allow
              ? `Requests wait up to 2 hours. At most ${state.limit} at once: ${state.active} now.`
              : "Off. Requests are refused at once, and the cloud chat is told it can be turned on here."
        }
        control={
          <Switch
            checked={allow}
            disabled={!state || saving}
            onCheckedChange={(checked) =>
              void setChatRequestsAllowed(Boolean(checked)).then((failure) => {
                if (failure) {
                  toastManager.add({ type: "error", title: "Couldn't save", description: failure });
                }
              })
            }
            aria-label="Allow cloud chats to ask to start chats here"
            data-testid="chat-requests-allow"
          />
        }
      />
      <SettingsRow
        title="Recent requests"
        description={
          entries.length === 0
            ? "No requests yet. When a cloud chat asks, it shows here with what you decided."
            : "What cloud chats asked here, and what became of it."
        }
      >
        {entries.length > 0 ? (
          <ul className="-mx-1 flex flex-col pt-2 pb-3" data-testid="chat-requests-journal">
            {entries.map((request) => (
              <JournalRow key={request.id} request={request} hostId={hostId} />
            ))}
          </ul>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}

function JournalRow(props: { request: ChatRequestView; hostId: EnvironmentId }) {
  const navigate = useNavigate();
  const { request } = props;
  const chip = statusChip(request.status);
  const threadId = request.status === "started" ? request.threadId : null;
  return (
    <li
      className="flex items-center gap-2.5 rounded-md px-1 py-1.5 text-xs"
      data-testid={`chat-requests-journal-${request.id}`}
    >
      <Badge variant={CHIP_VARIANT[chip.tone]} size="sm" className="w-16 shrink-0">
        {chip.label}
      </Badge>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-foreground" title={request.gist}>
          {request.gist}
        </span>
        <span className="truncate text-[11px] text-muted-foreground/80">
          From “{fromTitle(request)}” on {computerName(request)}
          {request.decidedVia === "telegram" ? " · answered in Telegram" : ""}
          {request.reason && (request.status === "expired" || request.status === "refused")
            ? ` · ${request.reason}`
            : ""}
        </span>
      </div>
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {journalTimeLabel(journalAt(request))}
      </span>
      {threadId ? (
        <Button
          size="xs"
          variant="ghost"
          className="shrink-0"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(props.hostId, ThreadId.make(threadId))),
            })
          }
        >
          Open chat
        </Button>
      ) : null}
    </li>
  );
}
