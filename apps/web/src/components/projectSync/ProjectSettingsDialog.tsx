/**
 * Project settings: "On all my computers" (the switch, the status, Keep mine
 * / Keep theirs after a conflict), the project's versions, what travels and
 * what stays, and its keys — names only; a value goes in once and never comes
 * back to the screen.
 *
 * @module projectSync/ProjectSettingsDialog
 */
import {
  PROJECT_KEYS_LINE,
  type EnvironmentId,
  type ProjectId,
  type ProjectSecretsList,
  type ProjectSyncEntry,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { useState } from "react";

import { useDevMode } from "../../devMode";
import { readEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ProjectFiles } from "./ProjectFiles";
import { ProjectTeam } from "./ProjectTeam";
import { ProjectVersions } from "./ProjectVersions";
import { conflictLine, hostLine, mineWasReplaced, syncLabel } from "./projectSync.logic";
import { projectSyncQueryKey, useRefreshProjectSync } from "./useProjectSync";

export interface ProjectSettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly name: string;
  readonly cwd: string;
}

export function ProjectSettingsDialog(props: {
  target: ProjectSettingsTarget | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={props.target !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      {props.target ? (
        <ProjectSettingsBody
          key={`${props.target.environmentId}:${props.target.projectId}`}
          target={props.target}
          onClose={props.onClose}
        />
      ) : null}
    </Dialog>
  );
}

const fail = (title: string, error: unknown) =>
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });

function ProjectSettingsBody(props: { target: ProjectSettingsTarget; onClose: () => void }) {
  const { target } = props;
  const devMode = useDevMode();
  const api = readEnvironmentApi(target.environmentId);
  const refresh = useRefreshProjectSync();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: projectSyncQueryKey(target.environmentId),
    queryFn: () => api!.projectSync.status(),
    enabled: !!api,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.projects.some((entry) => entry.state === "syncing") ? 1_500 : 15_000,
  });
  const keysKey = ["projectSecrets", target.environmentId, target.projectId] as const;
  const keys = useQuery({
    queryKey: keysKey,
    queryFn: () => api!.projectSync.secretsList({ projectId: target.projectId }),
    enabled: !!api,
    retry: false,
  });
  const [working, setWorking] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const syncRefreshed = (next: ProjectSyncEntry) => refresh(target.environmentId, next);

  const entry: ProjectSyncEntry | null =
    status.data?.projects.find((item) => item.projectId === target.projectId) ?? null;
  const enabled = entry?.enabled ?? false;
  const available = status.data?.available ?? true;

  const act = async (what: string, run: () => Promise<ProjectSyncEntry>) => {
    setWorking(what);
    try {
      refresh(target.environmentId, await run());
      void queryClient.invalidateQueries({ queryKey: keysKey });
    } catch (error) {
      fail("Couldn't do that", error);
      refresh(target.environmentId);
    } finally {
      setWorking(null);
    }
  };

  const setKeys = (list: ProjectSecretsList) => queryClient.setQueryData(keysKey, list);
  const saveKey = async () => {
    const name = keyName.trim();
    if (!api || !name || !keyValue) return;
    setWorking("key");
    try {
      setKeys(
        await api.projectSync.secretsSet({ projectId: target.projectId, name, value: keyValue }),
      );
      setKeyName("");
      setKeyValue("");
    } catch (error) {
      fail(`Couldn't save ${name}`, error);
      void queryClient.invalidateQueries({ queryKey: keysKey });
    } finally {
      setWorking(null);
    }
  };
  const removeKey = async (name: string) => {
    if (!api) return;
    setWorking(`remove:${name}`);
    try {
      setKeys(await api.projectSync.secretsRemove({ projectId: target.projectId, name }));
    } catch (error) {
      fail(`Couldn't remove ${name}`, error);
    } finally {
      setWorking(null);
    }
  };

  return (
    <DialogPopup className="max-w-lg" data-testid="project-settings-dialog">
      <DialogHeader>
        <DialogTitle>{target.name}</DialogTitle>
        <DialogDescription>{target.cwd}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-5">
        <section className="space-y-2">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">On all my computers</div>
              <p className="text-xs text-muted-foreground">
                The same folder on every computer of yours, kept in your Uno cloud. Keys, packages
                and builds stay out of it.
              </p>
            </div>
            <Switch
              aria-label="On all my computers"
              data-testid="project-sync-switch"
              checked={enabled}
              disabled={!api || working !== null || (!available && !enabled)}
              onCheckedChange={(checked) =>
                void act("toggle", () =>
                  api!.projectSync.setEnabled({ projectId: target.projectId, enabled: checked }),
                )
              }
            />
          </div>
          {!available && status.data?.unavailableReason ? (
            <p className="text-xs text-muted-foreground">{status.data.unavailableReason}</p>
          ) : null}
          {entry && enabled && entry.state !== "conflict" ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1" data-testid="project-sync-status">
                {working === "toggle" ? "Syncing…" : syncLabel(entry)}
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={working !== null || entry.state === "syncing"}
                onClick={() =>
                  void act("sync", () => api!.projectSync.syncNow({ projectId: target.projectId }))
                }
              >
                <RefreshCwIcon className={working === "sync" ? "animate-spin" : undefined} />
                Sync now
              </Button>
            </div>
          ) : null}
          {enabled && entry?.host ? (
            <p className="text-xs break-all text-muted-foreground" data-testid="project-sync-host">
              {hostLine(entry.host, devMode)}
            </p>
          ) : null}
          {enabled && (entry?.held?.length ?? 0) > 0 && entry?.state === "conflict" ? (
            // In a conflict the status line says the conflict: the waiting files still need a word.
            <p className="text-xs text-muted-foreground" data-testid="project-sync-held">
              {entry.held?.join(", ")} waiting here: it looks like there's a key inside.
            </p>
          ) : null}
          {entry?.state === "conflict" ? (
            <div
              className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/8 p-3 text-xs"
              data-testid="project-sync-conflict"
            >
              <p className="text-foreground">⚠ {conflictLine(entry)}</p>
              <div className="flex flex-wrap gap-2">
                {entry.conflict?.person && !mineWasReplaced(entry.conflict) ? null : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={working !== null}
                    onClick={() =>
                      void act("mine", () =>
                        api!.projectSync.resolve({ projectId: target.projectId, keep: "mine" }),
                      )
                    }
                  >
                    {entry.conflict?.person ? "Bring mine back" : "Keep mine"}
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={working !== null}
                  onClick={() =>
                    void act("theirs", () =>
                      api!.projectSync.resolve({ projectId: target.projectId, keep: "theirs" }),
                    )
                  }
                >
                  Keep theirs
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={working !== null}
                  onClick={() =>
                    void act("dismiss", () =>
                      api!.projectSync.resolve({ projectId: target.projectId, keep: "dismiss" }),
                    )
                  }
                >
                  OK, as it is
                </Button>
              </div>
            </div>
          ) : null}
        </section>

        {enabled ? (
          <>
            <ProjectVersions target={target} onRestored={syncRefreshed} />
            <ProjectFiles target={target} keyCount={keys.data?.secrets.length ?? 0} />
            {entry?.name ? (
              <ProjectTeam syncName={entry.name} teamId={entry.team?.id ?? null} />
            ) : null}
          </>
        ) : null}

        <section className="space-y-2" data-testid="project-keys">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <KeyRoundIcon className="size-4 text-muted-foreground" />
            Keys
          </div>
          <p className="text-xs text-muted-foreground">
            {entry?.team
              ? `${entry.team.owner} chooses which keys you get. They land in this project's .env on this computer. A key you add here stays here.`
              : keys.data?.synced
                ? PROJECT_KEYS_LINE
                : "API keys and tokens of this project, in its .env on this computer. Turn on On all my computers and they travel with the project, never in its files."}
          </p>
          {keys.data?.vaultError ? (
            <p className="text-xs text-amber-600">{keys.data.vaultError}</p>
          ) : null}
          <ul className="divide-y divide-border rounded-md border border-border">
            {(keys.data?.secrets ?? []).length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">No keys yet.</li>
            ) : (
              keys.data!.secrets.map((secret) => (
                <li key={secret.name} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                  <code className="min-w-0 flex-1 truncate font-mono text-foreground">
                    {secret.name}
                  </code>
                  <span className="shrink-0 text-muted-foreground">
                    {secret.inVault
                      ? entry?.team
                        ? `from ${entry.team.owner}`
                        : "all computers"
                      : "this computer"}
                  </span>
                  {entry?.team && secret.inVault ? null : (
                    <button
                      type="button"
                      aria-label={`Remove ${secret.name}`}
                      disabled={working !== null}
                      onClick={() => void removeKey(secret.name)}
                      className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                    >
                      <TrashIcon className="size-3.5" />
                    </button>
                  )}
                </li>
              ))
            )}
          </ul>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void saveKey();
            }}
          >
            <Input
              aria-label="Key name"
              placeholder="OPENAI_API_KEY"
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              className="w-44 font-mono"
            />
            <Input
              aria-label="Key value"
              type="password"
              autoComplete="off"
              placeholder="Value"
              value={keyValue}
              onChange={(event) => setKeyValue(event.target.value)}
              className="min-w-0 flex-1"
            />
            <Button
              type="submit"
              size="sm"
              disabled={!keyName.trim() || !keyValue || working !== null}
            >
              Save
            </Button>
          </form>
        </section>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={props.onClose}>
          Done
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
