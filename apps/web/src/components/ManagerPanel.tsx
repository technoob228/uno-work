/**
 * Assistant (manager agent) panel — the view behind the pinned "Assistant"
 * sidebar entry. Shows pending write proposals filed by the manager brain
 * with Approve/Deny controls, plus a short history of resolved ones.
 *
 * Assistants belong to a daemon, so this lists the ones on the environment
 * currently selected in the sidebar and says which that is. Every row links
 * on with that environment in the path, so the settings page it opens can
 * never drift to another machine.
 *
 * The proposal cards and their polling live in `helper/ProposalsList` and are
 * shared with the Advanced section of the Telegram settings page.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { BotIcon, PlusIcon, RefreshCwIcon, Settings2Icon } from "lucide-react";
import type { EnvironmentId, ManagerAssistantSummary } from "@t3tools/contracts";

import { EnvironmentScopeBanner } from "../environments/scope/EnvironmentScopeBanner";
import { useEnvironmentScope } from "../environments/scope/scopes";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useStore } from "../store";
import { createAssistant, listAssistants } from "../lib/managerApi";
import { ProposalsList, useManagerProposals } from "./helper/ProposalsList";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";

export function ManagerPanel() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  // This is a listing, not an editor: the sidebar's selection is the right
  // source here. Every link out of it pins the id into the URL so the pages
  // that DO write can never be ambiguous.
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const scope = useEnvironmentScope(environmentId);
  const canMutate = scope?.availability.canMutate ?? false;
  const [assistants, setAssistants] = useState<ReadonlyArray<ManagerAssistantSummary>>([]);
  const [newAssistantName, setNewAssistantName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const proposals = useManagerProposals({ environmentId, canMutate, onError: setError });

  const refreshAssistants = useCallback(async () => {
    if (environmentId === null) return;
    try {
      const result = await listAssistants({ environmentId });
      setAssistants(result.assistants);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load assistants.");
    }
  }, [environmentId]);

  const refreshProposals = proposals.refresh;
  const refresh = useCallback(() => {
    void refreshAssistants();
    void refreshProposals();
  }, [refreshAssistants, refreshProposals]);

  useEffect(() => {
    void refreshAssistants();
  }, [refreshAssistants]);

  const handleCreateAssistant = useCallback(() => {
    if (environmentId === null || !canMutate) return;
    const name = newAssistantName.trim() || "Assistant";
    setCreating(true);
    void createAssistant({ environmentId, name })
      .then((result) => {
        setNewAssistantName("");
        void navigate({
          to: "/assistant/$environmentId/$projectId",
          params: { environmentId, projectId: result.projectId },
        });
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Failed to create assistant."),
      )
      .finally(() => setCreating(false));
  }, [canMutate, environmentId, newAssistantName, navigate]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <BotIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Assistant</span>
            {proposals.pending.length > 0 ? (
              <Badge variant="warning">{proposals.pending.length} pending</Badge>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <Button size="xs" variant="ghost" onClick={refresh} aria-label="Refresh">
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
            {environmentId ? (
              <EnvironmentScopeBanner scope={scope} environmentId={environmentId} />
            ) : null}
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
                        to="/assistant/$environmentId/$projectId"
                        params={{
                          environmentId: environmentId as EnvironmentId,
                          projectId: assistant.projectId,
                        }}
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
                <Button size="xs" disabled={creating || !canMutate} onClick={handleCreateAssistant}>
                  <PlusIcon className="size-3.5" />
                  Create
                </Button>
              </div>
            </section>

            <ProposalsList
              proposals={proposals.proposals}
              pending={proposals.pending}
              resolved={proposals.resolved}
              busyProposalId={proposals.busyProposalId}
              onResolve={proposals.resolve}
              emptyText="No pending proposals. The assistant files a proposal here (and in Telegram) whenever it wants to create a thread, send a turn, or answer a permission request."
            />
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
