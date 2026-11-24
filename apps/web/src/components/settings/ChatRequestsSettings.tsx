/**
 * Settings → Computer → "Cloud agents" (only on the person's own computer):
 *
 * - the switch: chats on the person's cloud computers may work here — run
 *   commands through "Connect my computer" (`my_computer_*`, T47) and ask to
 *   start chats here (T50). Off until the person turns it on (Misha 20.11);
 * - "Stop cloud agents" (the kill switch, Misha 23.11): off, and every command
 *   a cloud agent runs here right now is stopped;
 * - every command they ran here, newest first (the cloud side writes each one
 *   here before it runs);
 * - the chats trusted to start chats without Start, each with Revoke;
 * - the journal of the last requests (started ones open their chat).
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  type ChatRequestTrustedChat,
  type ChatRequestView,
  type EnvironmentId,
  type RemoteCommandLine,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { OctagonXIcon } from "lucide-react";

import {
  type ChatRequestTone,
  type CommandTone,
  cloudAgentsStatus,
  commandChip,
  commandEntries,
  commandSummary,
  computerName,
  fromTitle,
  journalAt,
  journalEntries,
  journalTimeLabel,
  statusChip,
} from "../../chatRequests/chatRequests.logic";
import {
  revokeChatRequestTrust,
  setChatRequestsAllowed,
  stopCloudAgents,
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

const COMMAND_VARIANT: Record<CommandTone, "secondary" | "success" | "error"> = {
  ran: "secondary",
  allowed: "success",
  refused: "error",
};

const failed = (title: string) => (failure: string | null) => {
  if (failure) toastManager.add({ type: "error", title, description: failure });
};

/** The section, when the computer on screen is the one these requests come to. */
export function ChatRequestsSettingsSection(props: {
  readonly environmentId: EnvironmentId | null;
  readonly isCloud: boolean;
}) {
  const hostId = useChatRequestsHostId();
  const state = useChatRequestsStore((store) => store.state);
  const saving = useChatRequestsStore((store) => store.busy.allow === true);
  const stopping = useChatRequestsStore((store) => store.busy.stop === true);
  useMinuteClock();
  if (props.isCloud || !hostId || props.environmentId !== hostId) return null;
  const entries = journalEntries(state);
  const commands = commandEntries(state);
  const trusted = state?.trustedChats ?? [];
  const allow = state?.allow ?? false;

  return (
    <SettingsSection title="Cloud agents">
      <SettingsRow
        title="Let cloud agents work on this computer"
        description="Chats on your cloud computers can run commands here through Connect my computer, and ask to start a chat here. Every command shows below before it runs; a push, an install or anything risky waits for your Allow in that chat or in your Telegram. ssh to other machines is never allowed. Off by default."
        status={state ? cloudAgentsStatus(state) : null}
        control={
          <Switch
            checked={allow}
            disabled={!state || saving || stopping}
            onCheckedChange={(checked) =>
              void setChatRequestsAllowed(Boolean(checked)).then(failed("Couldn't save"))
            }
            aria-label="Let cloud agents work on this computer"
            data-testid="chat-requests-allow"
          />
        }
      />
      <SettingsRow
        title="Stop cloud agents"
        description="Turns the switch off and stops every command a cloud agent is running here right now. Chats already started here keep their history; nothing new comes in until you turn it on again."
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={!state || stopping}
            onClick={() =>
              void stopCloudAgents().then((failure) => {
                if (failure) {
                  failed("Couldn't stop them")(failure);
                  return;
                }
                toastManager.add({
                  type: "success",
                  title: "Cloud agents stopped",
                  description:
                    "What they ran here was stopped. Turn the switch on to let them back.",
                });
              })
            }
            data-testid="chat-requests-stop"
          >
            <OctagonXIcon className="size-3.5" aria-hidden />
            Stop cloud agents
          </Button>
        }
      />
      <SettingsRow
        title="Commands from cloud agents"
        description={
          commands.length === 0
            ? "None yet. When a cloud chat runs a command, reads or writes a file here, it shows here first."
            : "What cloud chats did here, newest first. Each line is written here before the command runs."
        }
      >
        {commands.length > 0 ? (
          <ul
            className="-mx-1 flex max-h-80 flex-col overflow-y-auto pt-2 pb-3"
            data-testid="chat-requests-commands"
          >
            {commands.map((line) => (
              <CommandRow key={`${line.at}|${line.kind}|${line.summary}`} line={line} />
            ))}
          </ul>
        ) : null}
      </SettingsRow>
      {trusted.length > 0 ? (
        <SettingsRow
          title="Chats that start without asking"
          description="You ticked “Don't ask again” for these. Their requests start here at once while cloud agents are on; commands still follow the same rules."
        >
          <ul className="-mx-1 flex flex-col pt-2 pb-3" data-testid="chat-requests-trusted">
            {trusted.map((chat) => (
              <TrustedRow key={`${chat.boxId ?? ""}:${chat.threadId}`} chat={chat} />
            ))}
          </ul>
        </SettingsRow>
      ) : null}
      <SettingsRow
        title="Recent requests"
        description={
          entries.length === 0
            ? "No requests yet. When a cloud chat asks to start a chat here, it shows here with what you decided."
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

function CommandRow(props: { line: RemoteCommandLine }) {
  const { line } = props;
  const chip = commandChip(line);
  return (
    <li className="flex items-center gap-2.5 rounded-md px-1 py-1.5 text-xs">
      <Badge variant={COMMAND_VARIANT[chip.tone]} size="sm" className="w-16 shrink-0">
        {chip.label}
      </Badge>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-mono text-[11px] text-foreground" title={line.summary}>
          {commandSummary(line)}
        </span>
        <span className="truncate text-[11px] text-muted-foreground/80">
          From “{line.threadTitle || "a chat"}” on {line.computerName}
          {line.outcome === "refused" && line.reason ? ` · ${line.reason}` : ""}
        </span>
      </div>
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {journalTimeLabel(line.at)}
      </span>
    </li>
  );
}

function TrustedRow(props: { chat: ChatRequestTrustedChat }) {
  const { chat } = props;
  const busy = useChatRequestsStore(
    (store) => store.busy[`trust:${chat.boxId ?? ""}:${chat.threadId}`] === true,
  );
  return (
    <li className="flex items-center gap-2.5 rounded-md px-1 py-1.5 text-xs">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-foreground">“{chat.threadTitle || "A chat"}”</span>
        <span className="truncate text-[11px] text-muted-foreground/80">
          On {chat.computerName || "a cloud computer"} · since {journalTimeLabel(chat.since)}
        </span>
      </div>
      <Button
        size="xs"
        variant="outline"
        className="shrink-0"
        disabled={busy}
        onClick={() =>
          void revokeChatRequestTrust({ boxId: chat.boxId, threadId: chat.threadId }).then(
            failed("Couldn't revoke"),
          )
        }
      >
        Revoke
      </Button>
    </li>
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
          {request.trusted === true
            ? " · started without asking (trusted chat)"
            : request.decidedVia === "telegram"
              ? " · answered in Telegram"
              : ""}
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
