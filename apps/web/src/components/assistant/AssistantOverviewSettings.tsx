/**
 * Settings → Assistant, top of the page (0.0.85): what Uno is, whether it
 * shows in the sidebar, what it can see and manage, and where you can talk to
 * it (Telegram / Slack, through the same guided dialog as the chat header).
 * The full connector page (groups, per-chat routing, addressing, tokens)
 * follows below it.
 */
import { ASSISTANT_PROJECT_ID, type EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { BotIcon, ShieldCheckIcon, SendIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  ASSISTANT_HARNESS_NOTE,
  ASSISTANT_VALUE_LINE,
  slackChannelState,
  telegramChannelState,
  type ChannelState,
} from "../../assistant/assistantChat.logic";
import { useShowAssistantInSidebar } from "../../assistant/assistantPrefs";
import { useEnvironmentScope } from "../../environments/scope/scopes";
import { listProjectsForAccessPicker, updateAssistantAccess } from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Switch } from "../ui/switch";
import {
  allowlistFromScopeForm,
  describeScope,
  pickableProjects,
  scopeFormFromAllowlist,
  type AssistantScopeForm,
} from "./assistantScope.logic";
import {
  ConnectChannelDialog,
  type ConnectChannel,
  useAssistantSummary,
} from "./ConnectChannelDialog";

const CHANNEL_COPY: Record<ChannelState, { label: string; tone: string; action: string }> = {
  on: { label: "Connected", tone: "text-success", action: "Manage" },
  problem: { label: "Needs a look", tone: "text-amber-600 dark:text-amber-400", action: "Fix" },
  off: { label: "Not connected", tone: "text-muted-foreground", action: "Connect" },
};

export function AssistantOverviewSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const scope = useEnvironmentScope(environmentId);
  const canMutate = scope?.availability.canMutate ?? false;
  const [showInSidebar, setShowInSidebar] = useShowAssistantInSidebar();
  const [connecting, setConnecting] = useState<ConnectChannel | null>(null);
  const summary = useAssistantSummary(environmentId, false);
  const projects = useQuery({
    queryKey: ["uno-assistant", "access-projects", environmentId],
    queryFn: () => listProjectsForAccessPicker({ environmentId }),
    retry: false,
  });
  const token = summary.data?.token ?? null;
  const [form, setForm] = useState<AssistantScopeForm>(() => scopeFormFromAllowlist("all"));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // The stored choice, until the person changes something here.
  useEffect(() => {
    if (!dirty && token) setForm(scopeFormFromAllowlist(token.projectAllowlist));
  }, [dirty, token]);

  const listed = useMemo(() => pickableProjects(projects.data ?? []), [projects.data]);

  const save = async () => {
    if (!token) return;
    setSaving(true);
    setMessage(null);
    try {
      await updateAssistantAccess({
        environmentId,
        projectId: ASSISTANT_PROJECT_ID,
        projectAllowlist: allowlistFromScopeForm(form),
        scopes: token.scopes,
        autoApprove: token.autoApprove,
      });
      setDirty(false);
      await summary.refetch();
      setMessage({ ok: true, text: "Saved. Uno follows it from its next step." });
    } catch (cause) {
      setMessage({
        ok: false,
        text: cause instanceof Error ? cause.message : "Couldn't save.",
      });
    } finally {
      setSaving(false);
    }
  };

  const telegram = summary.data ? telegramChannelState(summary.data.telegram) : "off";
  const slack = summary.data ? slackChannelState(summary.data.slack) : "off";

  return (
    <>
      <SettingsSection title="Uno, your assistant" icon={<BotIcon className="size-3.5" />}>
        <SettingsRow title="What it does" description={ASSISTANT_VALUE_LINE} />
        <SettingsRow
          title="Runs on Hermes"
          description={`${ASSISTANT_HARNESS_NOTE} The model is picked in the Uno chat's header.`}
        />
        <SettingsRow
          title="Show in sidebar"
          description="Hidden, Uno still works and stays on Home and in ⌘K."
          control={
            <Switch
              checked={showInSidebar}
              onCheckedChange={(checked) => setShowInSidebar(checked === true)}
              aria-label="Show Uno in the sidebar"
              data-testid="uno-settings-show-in-sidebar"
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Can see and manage"
        icon={<ShieldCheckIcon className="size-3.5" />}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!canMutate || !dirty || saving || !token}
            onClick={() => void save()}
            data-testid="uno-settings-scope-save"
          >
            Save
          </Button>
        }
      >
        <SettingsRow
          title="Projects Uno works in"
          description={
            token === null && !summary.isLoading
              ? "Uno isn't set up on this computer yet."
              : describeScope(form)
          }
        >
          <div className="flex flex-col gap-3 pb-4">
            <RadioGroup
              value={form.mode}
              onValueChange={(value) => {
                setForm({ ...form, mode: value === "only" ? "only" : "all" });
                setDirty(true);
                setMessage(null);
              }}
              className="gap-2"
              aria-label="What Uno can see and manage"
              data-testid="uno-settings-scope"
            >
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Radio value="all" disabled={!canMutate} /> All projects
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Radio value="only" disabled={!canMutate} /> Only these projects
              </label>
            </RadioGroup>
            {form.mode === "only" ? (
              <ul className="ml-6 flex max-h-64 flex-col gap-1.5 overflow-y-auto">
                {listed.length === 0 ? (
                  <li className="text-xs text-muted-foreground">
                    No projects on this computer yet.
                  </li>
                ) : (
                  listed.map((project) => {
                    const id = `uno-scope-${project.id}`;
                    return (
                      <li key={project.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          id={id}
                          checked={form.selected.has(project.id)}
                          disabled={!canMutate}
                          onCheckedChange={(checked) => {
                            const next = new Set(form.selected);
                            if (checked === true) next.add(project.id);
                            else next.delete(project.id);
                            setForm({ ...form, selected: next });
                            setDirty(true);
                            setMessage(null);
                          }}
                        />
                        <label htmlFor={id} className="cursor-pointer truncate">
                          {project.title}
                        </label>
                      </li>
                    );
                  })
                )}
              </ul>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Applies to listing, starting and messaging chats. Its own conversations are always in.
            </p>
            {message ? (
              <p
                className={cn(
                  "text-xs",
                  message.ok ? "text-muted-foreground" : "text-destructive-foreground",
                )}
              >
                {message.text}
              </p>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Talk to Uno from" icon={<SendIcon className="size-3.5" />}>
        <SettingsRow
          title="Telegram"
          description={
            summary.data?.telegram.botUsername
              ? `Your bot @${summary.data.telegram.botUsername}. Messages go to Uno's main conversation.`
              : "Your own bot; messages go to Uno's main conversation."
          }
          status={
            <span className={CHANNEL_COPY[telegram].tone}>{CHANNEL_COPY[telegram].label}</span>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!canMutate}
              onClick={() => setConnecting("telegram")}
              data-testid="uno-settings-connect-telegram"
            >
              {CHANNEL_COPY[telegram].action}
            </Button>
          }
        />
        <SettingsRow
          title="Slack"
          description="Your own Slack app; each channel gets its own conversation with Uno."
          status={<span className={CHANNEL_COPY[slack].tone}>{CHANNEL_COPY[slack].label}</span>}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!canMutate}
              onClick={() => setConnecting("slack")}
              data-testid="uno-settings-connect-slack"
            >
              {CHANNEL_COPY[slack].action}
            </Button>
          }
        />
      </SettingsSection>

      <ConnectChannelDialog
        environmentId={environmentId}
        channel={connecting}
        onClose={() => {
          setConnecting(null);
          void summary.refetch();
        }}
      />
    </>
  );
}
