/**
 * The meetings coming up under "Join my calls": time, title, where, and a
 * switch per meeting ("don't send it to this one"). The notetaker decides by
 * the rule; a switch here wins over the rule for that one meeting.
 */
import type { AssistantCallsView } from "../../lib/assistantCallsApi";
import { Switch } from "../ui/switch";
import { callTimeLabel, whyNotLabel } from "./joinCalls.logic";

const STATUS: Readonly<Record<string, string>> = {
  queued: "joining",
  joining: "joining",
  lobby: "waiting to be let in",
  recording: "in the call",
  done: "notes on the way",
  failed: "couldn't join",
  not_admitted: "not let in",
  cancelled: "not going",
};

export function AssistantCallsList(props: {
  readonly view: AssistantCallsView;
  readonly onChoose: (key: string, choice: "join" | "skip" | "") => Promise<void> | void;
}) {
  const now = Date.now();
  const calls = props.view.upcoming
    .filter((call) => Date.parse(call.end) > now && (call.join || call.why !== "no call link"))
    .slice(0, 6);
  if (calls.length === 0) return null;
  return (
    <ul className="border-t border-border/70" data-testid="assistant-join-calls-list">
      {calls.map((call) => {
        const status = call.session ? (STATUS[call.session.status] ?? call.session.status) : "";
        const why = whyNotLabel(call);
        const live =
          call.session !== null &&
          ["joining", "lobby", "recording", "queued"].includes(call.session.status);
        return (
          <li
            key={call.key}
            className="flex items-center gap-3 px-3 py-2 text-sm"
            data-testid="assistant-join-calls-item"
          >
            <span className="w-24 shrink-0 text-xs text-muted-foreground tabular-nums">
              {callTimeLabel(call.start, now)}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {call.title || "Busy"}
              <span className="text-xs text-muted-foreground">
                {call.platformName ? ` · ${call.platformName}` : ""}
                {status ? ` · ${status}` : why ? ` · ${why}` : ""}
              </span>
            </span>
            <Switch
              checked={call.join}
              disabled={live}
              onCheckedChange={(checked) =>
                void props.onChoose(call.key, checked ? "join" : "skip")
              }
              aria-label={call.join ? `Don't send it to ${call.title}` : `Send it to ${call.title}`}
            />
          </li>
        );
      })}
    </ul>
  );
}
