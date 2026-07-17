/**
 * Assistant (manager agent) panel — the view behind the pinned "Assistant"
 * sidebar entry. Shows pending write proposals filed by the manager brain
 * with Approve/Deny controls, plus a short history of resolved ones.
 *
 * Chat with the manager happens through its own connectors (Telegram) for
 * now; this panel is the in-app approval and observability surface.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { BotIcon, PlusIcon, RefreshCwIcon, Settings2Icon } from "lucide-react";
import type {
  ManagerActionProposal,
  ManagerAssistantSummary,
  ManagerProposalId,
} from "@t3tools/contracts";

import {
  createAssistant,
  listAssistants,
  listManagerProposals,
  ManagerApiError,
  resolveManagerProposal,
} from "../lib/managerApi";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";

const REFRESH_INTERVAL_MS = 10_000;

function describeAction(proposal: ManagerActionProposal): {
  title: string;
  detail: string | null;
} {
  const action = proposal.action;
  switch (action.kind) {
    case "create-thread":
      return {
        title: `Create thread “${action.title}”`,
        detail: action.prompt,
      };
    case "send-turn":
      return {
        title: `Send a turn to thread ${action.threadId.slice(0, 8)}…`,
        detail: action.prompt,
      };
    case "interrupt-turn":
      return {
        title: `Interrupt the active turn of thread ${action.threadId.slice(0, 8)}…`,
        detail: null,
      };
    case "respond-to-request":
      return {
        title: `Answer approval request (${action.decision}) in thread ${action.threadId.slice(0, 8)}…`,
        detail: null,
      };
  }
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function minutesUntil(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
}

const STATUS_BADGE: Record<
  ManagerActionProposal["status"],
  "warning" | "success" | "error" | "outline"
> = {
  pending: "warning",
  approved: "success",
  denied: "error",
  expired: "outline",
};

function ProposalCard({
  proposal,
  busy,
  onResolve,
}: {
  proposal: ManagerActionProposal;
  busy: boolean;
  onResolve: (proposalId: ManagerProposalId, decision: "approved" | "denied") => void;
}) {
  const { title, detail } = describeAction(proposal);
  const isPending = proposal.status === "pending";
  return (
    <div className="rounded-2xl border border-border/60 bg-card/40 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{title}</span>
        <Badge variant={STATUS_BADGE[proposal.status]} className="shrink-0">
          {proposal.status}
        </Badge>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/70">
          {isPending
            ? `expires in ${minutesUntil(proposal.expiresAt)} min`
            : (proposal.resolvedBy ?? "")}
        </span>
      </div>
      {detail ? (
        <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
          {detail}
        </p>
      ) : null}
      <div className="mt-2.5 flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground/60">
          filed {formatClock(proposal.requestedAt)}
        </span>
        {isPending ? (
          <div className="ml-auto flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => onResolve(proposal.proposalId, "denied")}
            >
              Deny
            </Button>
            <Button
              size="xs"
              disabled={busy}
              onClick={() => onResolve(proposal.proposalId, "approved")}
            >
              Approve
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ManagerPanel() {
  const navigate = useNavigate();
  const [proposals, setProposals] = useState<ReadonlyArray<ManagerActionProposal> | null>(null);
  const [assistants, setAssistants] = useState<ReadonlyArray<ManagerAssistantSummary>>([]);
  const [newAssistantName, setNewAssistantName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyProposalId, setBusyProposalId] = useState<ManagerProposalId | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [proposalsResult, assistantsResult] = await Promise.all([
        listManagerProposals(),
        listAssistants(),
      ]);
      setProposals(proposalsResult.proposals);
      setAssistants(assistantsResult.assistants);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof ManagerApiError ? cause.message : "Failed to load assistant proposals.",
      );
    }
  }, []);

  const handleCreateAssistant = useCallback(() => {
    const name = newAssistantName.trim() || "Assistant";
    setCreating(true);
    void createAssistant(name)
      .then((result) => {
        setNewAssistantName("");
        void navigate({
          to: "/assistant/$projectId",
          params: { projectId: result.projectId },
        });
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Failed to create assistant."),
      )
      .finally(() => setCreating(false));
  }, [newAssistantName, navigate]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleResolve = useCallback(
    (proposalId: ManagerProposalId, decision: "approved" | "denied") => {
      setBusyProposalId(proposalId);
      void resolveManagerProposal({ proposalId, decision })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "Failed to resolve proposal.");
        })
        .finally(() => {
          setBusyProposalId(null);
          void refresh();
        });
    },
    [refresh],
  );

  const pending = useMemo(
    () => (proposals ?? []).filter((proposal) => proposal.status === "pending"),
    [proposals],
  );
  const resolved = useMemo(
    () => (proposals ?? []).filter((proposal) => proposal.status !== "pending").slice(0, 12),
    [proposals],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <BotIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Assistant</span>
            {pending.length > 0 ? <Badge variant="warning">{pending.length} pending</Badge> : null}
            <div className="ml-auto flex items-center gap-1">
              <Button size="xs" variant="ghost" onClick={() => void refresh()} aria-label="Refresh">
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
            {error ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                {error}
              </div>
            ) : null}

            <section className="space-y-2.5">
              <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                Assistants
              </h2>
              {assistants.map((assistant) => (
                <div
                  key={assistant.projectId}
                  className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/40 px-4 py-3"
                >
                  <BotIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{assistant.title}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {assistant.token?.projectAllowlist === "all"
                        ? "all projects"
                        : `${assistant.token?.projectAllowlist.length ?? 0} projects`}
                      {" · "}
                      {assistant.telegram.configured
                        ? `Telegram ${assistant.telegram.enabled ? "on" : "off"}${
                            assistant.telegram.botUsername
                              ? ` (@${assistant.telegram.botUsername})`
                              : ""
                          }`
                        : "no Telegram"}
                      {assistant.skills.length > 0 ? ` · ${assistant.skills.length} skills` : ""}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    render={
                      <Link
                        to="/assistant/$projectId"
                        params={{ projectId: assistant.projectId }}
                      />
                    }
                  >
                    <Settings2Icon className="size-3.5" />
                    Settings
                  </Button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newAssistantName}
                  onChange={(event) => setNewAssistantName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleCreateAssistant();
                  }}
                  placeholder="New assistant name…"
                  className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
                />
                <Button size="xs" disabled={creating} onClick={handleCreateAssistant}>
                  <PlusIcon className="size-3.5" />
                  Create
                </Button>
              </div>
            </section>

            <section className="space-y-2.5">
              <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                Pending approvals
              </h2>
              {pending.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground">
                  {proposals === null
                    ? "Loading…"
                    : "No pending proposals. The assistant files a proposal here (and in Telegram) whenever it wants to create a thread, send a turn, or answer a permission request."}
                </div>
              ) : (
                pending.map((proposal) => (
                  <ProposalCard
                    key={proposal.proposalId}
                    proposal={proposal}
                    busy={busyProposalId === proposal.proposalId}
                    onResolve={handleResolve}
                  />
                ))
              )}
            </section>

            {resolved.length > 0 ? (
              <section className="space-y-2.5">
                <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
                  Recent
                </h2>
                {resolved.map((proposal) => (
                  <ProposalCard
                    key={proposal.proposalId}
                    proposal={proposal}
                    busy={false}
                    onResolve={handleResolve}
                  />
                ))}
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
