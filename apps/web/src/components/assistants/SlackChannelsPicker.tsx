/**
 * "Channels … answers in" (decision 02.10): one Uno Slack app per workspace,
 * every assistant of the computer answers in its own channels, under its own
 * name. A channel belongs to one assistant: picking it here takes it from the
 * other one. Direct messages to the app ask "who is this for?".
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HashIcon, LoaderCircleIcon, LockIcon } from "lucide-react";
import { useState } from "react";

import { listSlackChannels, setSlackChannels, type SlackChannelView } from "../../lib/managerApi";
import { toastManager } from "../ui/toast";

export function SlackChannelsPicker({
  environmentId,
  projectId,
  name,
}: {
  environmentId: EnvironmentId;
  projectId: string;
  name: string;
}) {
  const queryClient = useQueryClient();
  const key = ["uno-slack-channels", environmentId, projectId] as const;
  const channels = useQuery({
    queryKey: key,
    queryFn: () =>
      listSlackChannels({ environmentId, projectId }).then((result) => result.channels),
    retry: false,
  });
  const [saving, setSaving] = useState<string | null>(null);
  if (channels.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading channels…</p>;
  }
  if (channels.isError || !channels.data) return null;
  const mine = channels.data.filter((channel) => channel.assistantProjectId === projectId);
  const toggle = async (channel: SlackChannelView) => {
    setSaving(channel.id);
    const next = mine.some((entry) => entry.id === channel.id)
      ? mine.filter((entry) => entry.id !== channel.id).map((entry) => entry.id)
      : [...mine.map((entry) => entry.id), channel.id];
    try {
      await setSlackChannels({ environmentId, projectId, channelIds: next });
      await queryClient.invalidateQueries({ queryKey: ["uno-slack-channels", environmentId] });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't change the channels",
        description: cause instanceof Error ? cause.message : "This computer didn't answer.",
      });
    } finally {
      setSaving(null);
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="slack-channels-picker">
      <span className="text-xs font-medium text-muted-foreground">Channels {name} answers in</span>
      <div className="flex max-h-48 flex-col overflow-y-auto rounded-lg border border-border/70">
        {channels.data.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No channels yet.</p>
        ) : (
          channels.data.map((channel) => {
            const isMine = channel.assistantProjectId === projectId;
            const taken = channel.assistantProjectId !== null && !isMine;
            return (
              <label
                key={channel.id}
                className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/40"
              >
                <input
                  type="checkbox"
                  checked={isMine}
                  disabled={saving !== null}
                  onChange={() => void toggle(channel)}
                />
                {channel.isPrivate ? (
                  <LockIcon className="size-3.5 text-muted-foreground" />
                ) : (
                  <HashIcon className="size-3.5 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{channel.name}</span>
                {saving === channel.id ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : null}
                {taken ? (
                  <span className="text-[11px] text-muted-foreground">another assistant</span>
                ) : channel.isPrivate && !channel.isMember ? (
                  <span className="text-[11px] text-muted-foreground">invite the app first</span>
                ) : null}
              </label>
            );
          })
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        One app in your Slack, each assistant under its own name. A direct message to the app asks
        who it is for.
      </p>
    </div>
  );
}
