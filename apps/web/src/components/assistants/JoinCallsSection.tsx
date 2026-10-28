/**
 * "Join my calls" (Misha 28.10: "one click to connect the calendar — the
 * assistant goes to calls"). One button does all of it: Google Calendar if
 * it isn't connected (the usual sign-in window), the Notetaker on the
 * assistant's computer if it isn't there, then on. Then: the next call,
 * what went wrong last, the meetings coming up with a switch each.
 *
 * Daemon: assistants/AssistantCallsService.ts; contract with the notetaker:
 * reports/day_2026-10-28/assistants-d-impl/CONTRACTS.md (W ↔ N).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, LoaderCircleIcon, VideoIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import {
  type AssistantCallsView,
  disableAssistantCalls,
  enableAssistantCalls,
  getAssistantCalls,
  setAssistantCallChoice,
} from "../../lib/assistantCallsApi";
import { cn } from "../../lib/utils";
import { connectorSignedIn } from "../setup/connectorSignIn.logic";
import { useConnectorActions } from "../setup/steps/ConnectorsStep";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AssistantCallsList } from "./AssistantCallsList";
import { joinCallsStage, nextCallLine, otherAssistantName } from "./joinCalls.logic";

export const CALLS_KEY = ["uno-assistant", "calls"] as const;

/** The one-click flow, shared by the assistant's page and the card in its chat. */
export function useJoinCalls(environmentId: string, projectId: string) {
  const env = environmentId as EnvironmentId;
  const queryClient = useQueryClient();
  const actions = useConnectorActions(env);
  const [busy, setBusy] = useState<null | "google" | "setting-up" | "off">(null);
  const [problem, setProblem] = useState<null | { needs: string; message: string }>(null);
  const query = useQuery({
    queryKey: [...CALLS_KEY, environmentId],
    queryFn: () => getAssistantCalls({ environmentId: env }),
    retry: false,
    staleTime: 10_000,
    refetchInterval: (q) => (q.state.data?.enabled ? 20_000 : false),
  });
  const set = (view: AssistantCallsView) =>
    queryClient.setQueryData([...CALLS_KEY, environmentId], view);

  const turnOn = async (allowLowMemory = false) => {
    setProblem(null);
    setBusy("setting-up");
    try {
      const result = await enableAssistantCalls({ environmentId: env, projectId, allowLowMemory });
      set(result.view);
      if (result.ok) {
        setBusy(null);
        return true;
      }
      if (result.needs === "google") {
        setBusy("google");
        await actions.connect("gmail");
        return false; // carried on below once the sign-in lands
      }
      setBusy(null);
      setProblem({ needs: result.needs, message: result.message });
    } catch (cause) {
      setBusy(null);
      setProblem({
        needs: "error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return false;
  };

  // Google signed in while we waited: go on by itself (the "one click").
  const gmailSignedIn = connectorSignedIn(actions.byProvider.get("gmail"));
  const resume = useEffectEvent(() => void turnOn());
  useEffect(() => {
    if (busy === "google" && gmailSignedIn) resume();
  }, [busy, gmailSignedIn]);
  // The sign-in window closed without a grant.
  useEffect(() => {
    if (busy === "google" && actions.pending === null && !gmailSignedIn) {
      const timer = window.setTimeout(() => setBusy(null), 3000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [busy, actions.pending, gmailSignedIn]);

  const turnOff = async () => {
    setBusy("off");
    try {
      set(await disableAssistantCalls({ environmentId: env }));
    } finally {
      setBusy(null);
    }
  };

  const choose = async (key: string, choice: "join" | "skip" | "") => {
    set(await setAssistantCallChoice({ environmentId: env, key, choice }));
  };

  return { view: query.data, loading: query.isLoading, busy, problem, turnOn, turnOff, choose };
}

function busyText(busy: "google" | "setting-up" | "off" | null): string | null {
  if (busy === "google") return "Waiting for Google Calendar…";
  if (busy === "setting-up") return "Setting up the notetaker…";
  return null;
}

export function JoinCallsSection(props: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly name: string;
}) {
  const calls = useJoinCalls(props.environmentId, props.projectId);
  const { view, busy, problem } = calls;
  const stage = joinCallsStage(view, props.projectId);
  const other = otherAssistantName(view, props.projectId);
  const on = stage !== "off";
  const waiting = busyText(busy);
  const now = Date.now();

  return (
    <section className="flex flex-col gap-2" data-testid="assistant-join-calls">
      <div className="flex h-6 items-center justify-between gap-2 px-1">
        <h2 className="text-[13px] font-medium text-foreground">Calls</h2>
      </div>
      <div className="rounded-lg border border-border bg-card/40">
        <div className="flex items-start gap-3 px-3 py-3">
          <VideoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-sm font-medium">Join my calls</span>
            {on ? (
              <span className="text-sm" data-testid="assistant-join-calls-next">
                {stage === "setting-up"
                  ? "Setting up the notetaker…"
                  : view
                    ? nextCallLine(view, now)
                    : ""}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                {props.name} sends a notetaker to your meetings with a call link — Meet, Zoom,
                Teams. You get the notes and action items here and in Telegram, and {props.name}{" "}
                offers the follow-up.
                {other
                  ? ` Now ${other} does this on this computer; turning it on here moves it.`
                  : ""}
              </span>
            )}
            {on && view?.problem ? (
              <span className="text-xs text-destructive" data-testid="assistant-join-calls-problem">
                {view.problem.text}
              </span>
            ) : null}
            {stage === "reconnect" ? (
              <span className="flex items-center gap-2 text-xs text-destructive">
                Google Calendar needs signing in again.
                <button
                  type="button"
                  className="cursor-pointer text-primary hover:underline"
                  onClick={() => void calls.turnOn()}
                >
                  Reconnect
                </button>
              </span>
            ) : null}
            {problem ? (
              <span className="text-xs text-destructive" data-testid="assistant-join-calls-error">
                {problem.message}
                {problem.needs === "memory" ? (
                  <button
                    type="button"
                    className="ml-2 cursor-pointer text-primary hover:underline"
                    onClick={() => void calls.turnOn(true)}
                  >
                    Turn on anyway
                  </button>
                ) : null}
              </span>
            ) : null}
            {waiting ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <LoaderCircleIcon className="size-3 animate-spin" /> {waiting}
              </span>
            ) : null}
          </div>
          {on ? (
            <Switch
              checked
              disabled={busy !== null}
              onCheckedChange={(checked) => {
                if (!checked) void calls.turnOff();
              }}
              aria-label="Join my calls"
              data-testid="assistant-join-calls-switch"
            />
          ) : (
            <Button
              size="sm"
              disabled={busy !== null || calls.loading}
              onClick={() => void calls.turnOn()}
              data-testid="assistant-join-calls-on"
            >
              {busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
              Join my calls
            </Button>
          )}
        </div>
        {on && view ? (
          <>
            <AssistantCallsList view={view} onChoose={calls.choose} />
            <p
              className={cn(
                "border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground",
              )}
            >
              In the call as “{view.botName}”. It goes to meetings you're in with someone else and a
              call link; the host may have to let it in.
              {view.google?.account ? ` Calendar: ${view.google.account}.` : ""}
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}

/** The card in the assistant's chat (`ask_user` with connect "calls"). */
export function InlineJoinCalls(props: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly disabled: boolean;
  readonly onDone: () => void;
}) {
  const calls = useJoinCalls(props.environmentId, props.projectId);
  const stage = joinCallsStage(calls.view, props.projectId);
  const [asked, setAsked] = useState(false);
  const onDone = useEffectEvent(props.onDone);
  useEffect(() => {
    if (asked && stage !== "off") onDone();
  }, [asked, stage]);
  const waiting = busyText(calls.busy);
  return (
    <div className="mt-3 flex flex-col gap-1.5" data-testid="pending-input-join-calls">
      {stage !== "off" && calls.view ? (
        <div className="flex items-center gap-2 text-sm">
          <CheckIcon className="size-4 text-success" />
          {nextCallLine(calls.view, Date.now())}
        </div>
      ) : (
        <Button
          size="sm"
          className="w-fit"
          disabled={props.disabled || calls.busy !== null}
          onClick={() => {
            setAsked(true);
            void calls.turnOn();
          }}
        >
          {waiting ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <VideoIcon className="size-3.5" />
          )}
          {waiting ?? "Join my calls"}
        </Button>
      )}
      {calls.problem ? (
        <span className="text-xs text-destructive">
          {calls.problem.message}
          {calls.problem.needs === "memory" ? (
            <button
              type="button"
              className="ml-2 cursor-pointer text-primary hover:underline"
              onClick={() => void calls.turnOn(true)}
            >
              Turn on anyway
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
