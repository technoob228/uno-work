/**
 * Instruction layers, in the order agents read them:
 *
 *   repository (`AGENTS.md`, read-only here) → workspace → this machine
 *
 * The machine layer wins because it describes physical truth — no AVX2 here,
 * the daemon runs under systemd — and a workspace rule that contradicts the
 * hardware is simply wrong on that machine.
 *
 * "Write to project" generates `.t3code/UNO_WORKSPACE.md` and leaves a
 * three-line pointer between markers in `AGENTS.md`. Delete the markers and we
 * do not put them back.
 */
import type { EnvironmentId, WorkspaceState } from "@t3tools/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  workspaceApplyInstructionsMutationOptions,
  workspaceInstructionsQueryOptions,
  workspaceSetInstructionsMutationOptions,
} from "../../lib/workspaceReactQuery";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const WORKSPACE_SCOPE = "*";

export function WorkspaceInstructionsSection({
  registryEnvironmentId,
  state,
}: {
  readonly registryEnvironmentId: EnvironmentId;
  readonly state: WorkspaceState | null;
}) {
  const queryClient = useQueryClient();
  const [targetEnvironmentId, setTargetEnvironmentId] =
    useState<EnvironmentId>(registryEnvironmentId);
  const [projectPath, setProjectPath] = useState("");
  const [workspaceDraft, setWorkspaceDraft] = useState<string | null>(null);
  const [machineDraft, setMachineDraft] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const instructionsQuery = useQuery(
    workspaceInstructionsQueryOptions({
      environmentId: registryEnvironmentId,
      targetEnvironmentId,
      projectPath: projectPath.trim().length > 0 ? projectPath.trim() : null,
    }),
  );

  const setInstructions = useMutation(
    workspaceSetInstructionsMutationOptions(registryEnvironmentId, queryClient),
  );
  const applyInstructions = useMutation(
    workspaceApplyInstructionsMutationOptions(registryEnvironmentId),
  );

  const layers = instructionsQuery.data?.layers ?? [];
  const repositoryLayer = layers.find((layer) => layer.kind === "repository");
  const workspaceLayer = layers.find((layer) => layer.kind === "workspace");
  const machineLayer = layers.find((layer) => layer.kind === "machine");

  // Drafts follow the selected machine: switching target without this would
  // silently carry one machine's unsaved text onto another.
  useEffect(() => {
    setWorkspaceDraft(null);
    setMachineDraft(null);
  }, [targetEnvironmentId]);

  return (
    <SettingsSection title="Agent instructions">
      <SettingsRow
        title="Layer them per machine"
        description="Repository text comes from git and is read-only here. The workspace layer applies everywhere; the machine layer overrides it."
        control={
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Machine"
              className="h-7 rounded-md border border-border bg-background px-2 text-xs"
              value={targetEnvironmentId}
              onChange={(event) => setTargetEnvironmentId(event.target.value as EnvironmentId)}
            >
              {(state?.machines ?? []).map((machine) => (
                <option key={machine.environmentId} value={machine.environmentId}>
                  {machine.label}
                </option>
              ))}
              {(state?.machines ?? []).length === 0 ? (
                <option value={registryEnvironmentId}>This machine</option>
              ) : null}
            </select>
            <Input
              aria-label="Project path"
              className="w-64"
              placeholder="/path/to/checkout (for the repository layer)"
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
            />
          </div>
        }
      />

      <div className="flex flex-col gap-3 px-1 pb-2">
        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-medium">1 · Repository</span>
            <span className="text-xs text-muted-foreground">
              {repositoryLayer?.source ?? "no project selected"} · read-only
            </span>
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap px-3 py-2 text-xs text-muted-foreground">
            {repositoryLayer?.text?.trim().length
              ? repositoryLayer.text
              : "Nothing yet — point at a checkout with an AGENTS.md."}
          </pre>
        </div>

        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-medium">2 · Workspace</span>
            <Button
              size="xs"
              variant="outline"
              disabled={workspaceDraft === null || setInstructions.isPending}
              onClick={() => {
                if (workspaceDraft === null) return;
                setInstructions.mutate(
                  { scope: WORKSPACE_SCOPE, text: workspaceDraft },
                  { onSuccess: () => setWorkspaceDraft(null) },
                );
              }}
            >
              Save
            </Button>
          </div>
          <Textarea
            aria-label="Workspace instructions"
            className="min-h-24 rounded-none border-0 text-xs"
            value={workspaceDraft ?? workspaceLayer?.text ?? ""}
            onChange={(event) => setWorkspaceDraft(event.target.value)}
            placeholder="Rules for every machine — e.g. production is touched only through a request."
          />
        </div>

        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-medium">3 · This machine</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">overrides the workspace</span>
              <Button
                size="xs"
                variant="outline"
                disabled={machineDraft === null || setInstructions.isPending}
                onClick={() => {
                  if (machineDraft === null) return;
                  setInstructions.mutate(
                    { scope: targetEnvironmentId, text: machineDraft },
                    { onSuccess: () => setMachineDraft(null) },
                  );
                }}
              >
                Save
              </Button>
            </div>
          </div>
          <Textarea
            aria-label="Machine instructions"
            className="min-h-24 rounded-none border-0 text-xs"
            value={machineDraft ?? machineLayer?.text ?? ""}
            onChange={(event) => setMachineDraft(event.target.value)}
            placeholder="Facts about this machine — no AVX2, run e2e headless, restart the systemd unit after server changes."
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            disabled={projectPath.trim().length === 0 || applyInstructions.isPending}
            onClick={() => {
              setApplyResult(null);
              applyInstructions.mutate(
                { environmentId: targetEnvironmentId, projectPath: projectPath.trim() },
                {
                  onSuccess: (result) =>
                    setApplyResult(
                      result.pointerWritten
                        ? `Wrote ${result.generatedPath} and refreshed the pointer in AGENTS.md.`
                        : `Wrote ${result.generatedPath}. AGENTS.md left alone — its marker block is gone, and we do not put it back.`,
                    ),
                  onError: (error) =>
                    setApplyResult(error instanceof Error ? error.message : String(error)),
                },
              );
            }}
          >
            Write to project
          </Button>
          {applyResult ? (
            <span className="text-xs text-muted-foreground">{applyResult}</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Generates .t3code/UNO_WORKSPACE.md in the checkout above.
            </span>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
