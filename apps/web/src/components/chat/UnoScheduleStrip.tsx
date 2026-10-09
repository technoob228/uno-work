/**
 * Under the header of a chat with Uno: what it runs on its own, one line per
 * schedule — "Every day at 09:00 · Morning plan  [Pause] [Remove]". Nothing
 * when there is nothing on schedule. The same schedules the console shows
 * under Schedule (they wake a sleeping computer); read by the daemon with the
 * computer's own token (`/api/manager/assistant/schedules`).
 */
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClockIcon, LoaderCircleIcon } from "lucide-react";

import { actOnAssistantSchedule, listAssistantSchedules } from "../../lib/managerApi";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { unoScheduleLine } from "./unoSchedules.logic";

const browserTimezone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
})();

export function unoSchedulesQueryKey(environmentId: EnvironmentId, projectId: ProjectId) {
  return ["uno-schedules", environmentId, projectId] as const;
}

export function UnoScheduleStrip({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const queryClient = useQueryClient();
  const key = unoSchedulesQueryKey(environmentId, projectId);
  const schedules = useQuery({
    queryKey: key,
    // An older daemon (no route) or a computer without the console: no strip.
    queryFn: () =>
      listAssistantSchedules({ environmentId, projectId })
        .then((result) => result.schedules)
        .catch(() => []),
    // Uno may add one in this very chat: look again every half a minute.
    refetchInterval: 30_000,
    retry: false,
  });
  const act = useMutation({
    mutationFn: (input: { scheduleId: number; action: "pause" | "resume" | "remove" }) =>
      actOnAssistantSchedule({ environmentId, projectId, ...input }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
    onError: (cause) =>
      toastManager.add({
        type: "error",
        title: "Couldn't change the schedule",
        description: cause instanceof Error ? cause.message : "Uno didn't answer.",
      }),
  });

  const list = schedules.data ?? [];
  if (list.length === 0) return null;
  return (
    <div className="border-b border-border px-3 py-1 sm:px-5" data-testid="uno-schedule-strip">
      <ul className="mx-auto flex w-full max-w-3xl flex-col">
        {list.map((schedule) => {
          const line = unoScheduleLine(schedule, browserTimezone);
          const busy = act.isPending && act.variables?.scheduleId === schedule.scheduleId;
          return (
            <li
              key={schedule.scheduleId}
              className="flex min-h-8 items-center gap-2 text-xs"
              data-testid="uno-schedule-row"
            >
              <AlarmClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                <span className="text-foreground">{line.when}</span>
                <span className="text-muted-foreground"> · {line.what}</span>
                {line.paused ? <span className="text-muted-foreground"> · Paused</span> : null}
              </span>
              {busy ? (
                <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : null}
              <Button
                size="xs"
                variant="ghost"
                disabled={act.isPending}
                onClick={() =>
                  act.mutate({
                    scheduleId: schedule.scheduleId,
                    action: line.paused ? "resume" : "pause",
                  })
                }
                data-testid="uno-schedule-pause"
              >
                {line.paused ? "Resume" : "Pause"}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={act.isPending}
                onClick={() => act.mutate({ scheduleId: schedule.scheduleId, action: "remove" })}
                data-testid="uno-schedule-remove"
              >
                Remove
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
