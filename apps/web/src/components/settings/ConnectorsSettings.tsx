/**
 * Settings → Connectors (Misha 16.10): the one place for the apps your AI
 * works in. The four apps in one click (OAuth through your Uno account) and
 * servers of your own by address — the same list as the setup's Connectors
 * step (`ConnectorsList`), plus who can use them: Uno and each teammate pick
 * from what is connected here.
 */
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";

import { DEMO } from "../../demo/demoFlag";
import { GitHubIcon } from "../Icons";
import { AssistantAvatar } from "../assistants/AssistantAvatar";
import { accessOf, connectorsLine } from "../assistants/assistantTeam.logic";
import { useConnectorItems } from "../assistants/TeammateAccess";
import { useAssistantTeam } from "../assistants/useAssistantTeam";
import { connectedSummary } from "../connectors/connectorsCatalog.logic";
import { ConnectorsList } from "../setup/steps/ConnectorsStep";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

export function ConnectorsSettings() {
  const navigate = useNavigate();
  const { items, actions, loading } = useConnectorItems();
  const team = useAssistantTeam().filter((member) => !member.revoked);
  const [details, setDetails] = useState(false);
  const connected = items.filter((item) => item.connected);
  const names = connected
    .filter((item) => item.kind === "app")
    .map((item) => ({ id: item.id, name: item.name }));

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-1 px-1" data-testid="settings-connectors">
        <h1 className="text-lg font-semibold">Connectors</h1>
        <p className="text-sm text-muted-foreground">
          Apps your AI can work in. Connect once here — Uno and your assistants use them in any
          chat. You approve each one on the app’s own page and can disconnect any time.
        </p>
      </div>

      {!loading && names.length === 0 ? (
        <div
          className="flex items-center gap-3 rounded-2xl border border-dashed border-border px-4 py-3.5"
          data-testid="settings-connectors-empty"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-background">
            <GitHubIcon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Nothing connected yet</div>
            <div className="text-xs text-muted-foreground">
              Start with GitHub: one click, then press Authorize on GitHub’s page.
            </div>
          </div>
          <Button
            size="sm"
            disabled={actions.pending !== null}
            onClick={() => void actions.connect("github")}
          >
            {actions.pending?.provider === "github" ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : null}
            Connect GitHub
          </Button>
        </div>
      ) : null}

      <SettingsSection title={loading ? "Apps" : `Apps · ${connectedSummary(items)}`}>
        <ConnectorsList className="rounded-none border-0" />
      </SettingsSection>

      {/* Per-teammate access ships with the team (Misha 16.10); the mock shows it already. */}
      {DEMO && team.length > 0 ? (
        <SettingsSection title="Who can use them">
          {team.map((member) => {
            const access = accessOf(member.profile);
            return (
              <button
                key={member.key}
                type="button"
                onClick={() =>
                  void navigate({
                    to: "/assistants",
                    search: {
                      view: "profile",
                      env: member.environmentId,
                      project: member.projectId,
                    },
                  })
                }
                className="flex w-full cursor-pointer items-center gap-3 border-t border-border/60 px-4 py-2.5 text-left first:border-t-0 hover:bg-accent/40 sm:px-5"
              >
                <AssistantAvatar
                  emoji={member.profile.emoji}
                  tone={member.profile.tone}
                  className="size-6"
                  emojiClassName="text-xs"
                />
                <span className="w-24 shrink-0 truncate text-sm font-medium">
                  {member.profile.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {names.length === 0 ? "—" : connectorsLine(access.connectors, names)}
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </SettingsSection>
      ) : null}

      <div className="px-1">
        <button
          type="button"
          onClick={() => setDetails((value) => !value)}
          aria-expanded={details}
          className="inline-flex cursor-pointer items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronRightIcon className={details ? "size-3 rotate-90" : "size-3"} />
          Details for developers
        </button>
        {details ? (
          <div className="mt-2 flex flex-col gap-1.5 rounded-xl border border-border px-4 py-3 text-xs">
            <p className="text-muted-foreground">
              Apps belong to your Uno account: the OAuth token stays in the console and never lands
              on a computer. Agents on every computer of the account get the tools through the
              built-in MCP server <code className="font-mono">uno-work</code>; for an assistant the
              computer’s Uno Work checks its level (none / read / read+write) on every call.
            </p>
            <p className="text-muted-foreground">
              Servers you add (<code className="font-mono">settings.mcpServers</code>) live on this
              computer only and reach every chat on it — they can’t be limited per assistant yet.
              Addresses show the host only: one may carry a token.
            </p>
            <p className="text-muted-foreground">
              Not covered: a chat can still use the <code className="font-mono">gh</code> CLI or a
              key from the terminal — that goes by Keys & tokens, not by these levels.
            </p>
            {items.map((item) => (
              <div key={item.id} className="flex gap-2">
                <span className="w-32 shrink-0 truncate">{item.name}</span>
                <span className="min-w-0 truncate font-mono text-muted-foreground">
                  {item.tech}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </SettingsPageContainer>
  );
}
