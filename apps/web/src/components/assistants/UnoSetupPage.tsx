/**
 * Uno's first click when it isn't set up (Misha 28.10, p.9):
 * `/assistants?view=uno-setup&env=<environmentId>` — one short screen:
 *
 * 1. What Uno thinks with — the one AI picker (`AssistantAiChoice`).
 * 2. Its mode — "Does it itself" / "Asks first" (its token's preset:
 *    full / helper; the daemon enforces it, not a prompt).
 * 3. Apps — Gmail, Drive, Notion, GitHub and your own MCP server, connected
 *    on the computer Uno lives on (the chats it starts there use them).
 *
 * "Start" saves the mode, marks the setup done (`setup: "done"`, so the next
 * click opens its chat, audit 27.10 #15) and opens its one chat.
 */
import { ASSISTANT_PROJECT_ID, type EnvironmentId, isAssistantProjectId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, LoaderCircleIcon, MoonIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { waitForThreadInStore } from "../../assistant/useAssistantChat";
import { useMachineRows } from "../../hooks/useMachineRows";
import { ensureAssistantChat, setAssistantPreset, updateAssistantTeam } from "../../lib/managerApi";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ConnectorsList } from "../setup/steps/ConnectorsStep";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { useAccountHomeEnvironmentId } from "./accountUno";
import { AssistantAiChoice } from "./AssistantAiChoice";
import { AssistantAvatar } from "./AssistantAvatar";
import { HANDS_WORK_LINE } from "./assistantJob.logic";
import { type AssistantMode, modeOf } from "./PersonaMode";
import { ModePicker } from "./PersonaParts";
import { isAsleep } from "./personaChannels";
import { TEAM_SUMMARIES_KEY, useAssistantTeam } from "./useAssistantTeam";
import { LOCAL_ASSISTANTS_KEY } from "./useAssistants";

function Section(props: {
  readonly n: number;
  readonly title: string;
  readonly line: string;
  readonly children: ReactNode;
  readonly testId: string;
}) {
  return (
    <section className="flex flex-col gap-3" data-testid={props.testId}>
      <div className="flex items-baseline gap-2">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
          {props.n}
        </span>
        <div>
          <h2 className="text-[15px] font-semibold">{props.title}</h2>
          <p className="text-xs text-muted-foreground">{props.line}</p>
        </div>
      </div>
      {props.children}
    </section>
  );
}

export function UnoSetupPage(props: { readonly environmentId?: string | undefined }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Without `env`: the account's home computer, where Uno lives (accountUno.ts).
  const home = useAccountHomeEnvironmentId();
  const environmentId = (props.environmentId ?? home ?? null) as EnvironmentId | null;
  const rows = useMachineRows();
  const row = rows.find((item) => item.environmentId === environmentId);
  const computer = row?.label ?? "this computer";
  const team = useAssistantTeam();
  const uno = team.find((member) => member.isUno && member.environmentId === environmentId) ?? null;
  const [picked, setPicked] = useState<AssistantMode | null>(null);
  const mode: AssistantMode = picked ?? (uno ? modeOf(uno) : "asks-first");
  const [busy, setBusy] = useState(false);
  const asleep = row ? isAsleep(row.status) : false;

  const start = async () => {
    if (!environmentId) return;
    setBusy(true);
    try {
      const allowlist = uno?.summary?.token?.projectAllowlist ?? "all";
      await setAssistantPreset({
        environmentId,
        projectId: ASSISTANT_PROJECT_ID,
        preset: mode === "itself" ? "full" : "helper",
        projects:
          allowlist === "all"
            ? "all"
            : allowlist.filter((id) => id !== ASSISTANT_PROJECT_ID && !isAssistantProjectId(id)),
      });
      await updateAssistantTeam({ environmentId, projectId: ASSISTANT_PROJECT_ID, setup: "done" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: TEAM_SUMMARIES_KEY }),
        queryClient.invalidateQueries({ queryKey: LOCAL_ASSISTANTS_KEY }),
      ]);
      const chat = await ensureAssistantChat({ environmentId });
      await waitForThreadInStore(environmentId, chat.threadId, 5_000);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId: chat.threadId }),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't set up Uno",
        description:
          cause instanceof Error && cause.message ? cause.message : `${computer} didn't answer.`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
        <header className="flex min-h-12 items-center gap-2 border-b border-border px-3 sm:px-5">
          <SidebarShowButton />
          <Button size="xs" variant="ghost" onClick={() => void navigate({ to: "/" })}>
            <ArrowLeftIcon className="size-3.5" />
            <span className="hidden sm:inline">Back</span>
          </Button>
          <span className="text-xs text-muted-foreground">Uno › Set up</span>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-7" data-testid="uno-setup">
            <div className="flex items-center gap-3">
              <AssistantAvatar
                emoji={uno?.profile.emoji ?? null}
                tone={uno?.profile.tone ?? "violet"}
                className="size-12"
              />
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Set up Uno</h1>
                <p className="text-sm text-muted-foreground">
                  Lives on {computer}. {HANDS_WORK_LINE}
                </p>
              </div>
            </div>
            {environmentId === null ? (
              <p className="text-sm text-muted-foreground">No computer is connected.</p>
            ) : (
              <>
                {asleep ? (
                  <div
                    className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-xs"
                    data-testid="uno-setup-asleep"
                  >
                    <MoonIcon className="mt-0.5 size-4 shrink-0 text-violet-500" />
                    <span>
                      <b className="font-semibold">{computer} is asleep.</b> Wake it on its page,
                      then come back here.
                    </span>
                  </div>
                ) : null}
                <Section n={1} title="AI" line="What Uno thinks with." testId="uno-setup-ai">
                  <AssistantAiChoice environmentId={environmentId} computer={computer} />
                </Section>
                <Section
                  n={2}
                  title="Mode"
                  line="Before it sends, pays or deletes something."
                  testId="uno-setup-mode"
                >
                  <ModePicker mode={mode} onChange={setPicked} testIdPrefix="uno-setup-mode" />
                </Section>
                <Section
                  n={3}
                  title="Apps"
                  line={`Connected on ${computer}: the chats Uno starts there use them.`}
                  testId="uno-setup-apps"
                >
                  <ConnectorsList environmentId={environmentId} />
                </Section>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => void start()}
                    disabled={busy || asleep}
                    data-testid="uno-setup-start"
                  >
                    {busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : null}
                    Start with Uno
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Change any of it later on its page.
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
