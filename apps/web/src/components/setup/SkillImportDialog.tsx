/**
 * The preview before a skill is added: what's inside (name and description
 * from each SKILL.md), where it's from, how many scripts come with it, and
 * where it goes — every project, or only this one.
 */
import type { EnvironmentId, SkillsStageResult } from "@t3tools/contracts";
import { ExternalLinkIcon, FileCode2Icon, Loader2Icon, ShieldAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { addStagedSkills, type SkillPlace } from "./skillImport";

function plural(count: number, word: string): string {
  return `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;
}

export function SkillImportDialog({
  environmentId,
  preview,
  project,
  existing,
  initialPlace = "computer",
  onClose,
  onAdded,
}: {
  environmentId: EnvironmentId | null;
  preview: SkillsStageResult | null;
  project: { readonly name: string; readonly path: string } | null;
  existing: { readonly computer: ReadonlySet<string>; readonly project: ReadonlySet<string> };
  /** A project's own skills/ opens on "Only this project". */
  initialPlace?: SkillPlace;
  onClose: () => void;
  onAdded: (count: number) => void;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [place, setPlace] = useState<SkillPlace>("computer");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Your own files: all of them. A whole repository from a link: you pick.
    const fromRepo = preview?.sourceUrl !== undefined && preview.skills.length > 3;
    setPicked(new Set(fromRepo ? [] : (preview?.skills.map((skill) => skill.key) ?? [])));
    setPlace(initialPlace === "project" && project ? "project" : "computer");
    setError(null);
  }, [preview, initialPlace, project]);
  const skills = useMemo(() => preview?.skills ?? [], [preview]);
  const many = skills.length > 3;
  const scripts = useMemo(
    () =>
      skills
        .filter((skill) => picked.has(skill.key))
        .reduce((sum, skill) => sum + skill.scripts, 0),
    [skills, picked],
  );
  const replaces = existing[place];
  const count = picked.size;

  const add = async () => {
    if (!environmentId || !preview || count === 0) return;
    setPending(true);
    setError(null);
    try {
      const added = await addStagedSkills({
        environmentId,
        token: preview.token,
        keys: skills.filter((skill) => picked.has(skill.key)).map((skill) => skill.key),
        place,
        projectPath: project?.path ?? null,
      });
      onAdded(added);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't add the skills.");
    } finally {
      setPending(false);
    }
  };
  const toggle = (key: string, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <Dialog open={preview !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogPopup className="max-w-xl" data-testid="setup-skill-import">
        <DialogHeader>
          <DialogTitle>
            {skills.length === 1
              ? `Add “${skills[0]!.name}”?`
              : preview?.sourceUrl && many
                ? `Pick from ${plural(skills.length, "skill")}`
                : `Add ${plural(skills.length, "skill")}?`}
          </DialogTitle>
          <DialogDescription>
            From{" "}
            {preview?.sourceUrl ? (
              <button
                type="button"
                onClick={() => openInstallDocs(preview.sourceUrl!)}
                className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
              >
                {preview.sourceLabel}
                <ExternalLinkIcon className="size-3" />
              </button>
            ) : (
              <span className="font-medium text-foreground">{preview?.sourceLabel}</span>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {many ? (
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>{plural(count, "skill")} picked</span>
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() =>
                  setPicked(count === skills.length ? new Set() : new Set(skills.map((s) => s.key)))
                }
              >
                {count === skills.length ? "Pick none" : "Pick all"}
              </button>
            </div>
          ) : null}
          <div className="max-h-[45vh] overflow-y-auto rounded-xl border border-border">
            {skills.map((skill, index) => (
              <label
                key={skill.key}
                className={cn(
                  "flex cursor-pointer items-start gap-3 px-3 py-2.5",
                  index > 0 && "border-t border-border",
                )}
              >
                <Checkbox
                  className="mt-0.5"
                  checked={picked.has(skill.key)}
                  onCheckedChange={(checked) => toggle(skill.key, checked === true)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{skill.name}</span>
                  <span
                    className="mt-0.5 line-clamp-2 text-xs text-muted-foreground"
                    title={skill.description}
                  >
                    {skill.description}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                    <span>{plural(skill.files, "file")}</span>
                    {skill.scripts > 0 ? (
                      <span className="inline-flex items-center gap-1 text-foreground">
                        <FileCode2Icon className="size-3" />
                        {plural(skill.scripts, "script")}
                      </span>
                    ) : null}
                    {skill.location ? <span className="font-mono">{skill.location}</span> : null}
                    {replaces.has(skill.name) ? (
                      <span className="text-warning-foreground">Replaces the one you have</span>
                    ) : null}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {preview && preview.skipped.length > 0 ? (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                {plural(preview.skipped.length, "folder")} skipped
              </summary>
              <ul className="mt-1 space-y-0.5">
                {preview.skipped.map((item) => (
                  <li key={item.location}>
                    <span className="font-mono">{item.location}</span> — {item.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="mt-4 text-sm font-medium">Use it in</div>
          <RadioGroup
            className="mt-2 gap-2"
            value={place}
            onValueChange={(value) => setPlace(value as SkillPlace)}
          >
            <label className="flex cursor-pointer items-start gap-2.5">
              <Radio value="computer" className="mt-0.5" />
              <span className="text-sm">
                All projects
                <span className="block text-xs text-muted-foreground">
                  Every AI on this computer, in every project
                </span>
              </span>
            </label>
            <label
              className={cn("flex items-start gap-2.5", project ? "cursor-pointer" : "opacity-60")}
            >
              <Radio value="project" className="mt-0.5" disabled={!project} />
              <span className="text-sm">
                {project ? `Only ${project.name}` : "Only this project"}
                <span className="block text-xs text-muted-foreground">
                  {project
                    ? "Saved in the project, so it goes along with it"
                    : "Make a project first"}
                </span>
              </span>
            </label>
          </RadioGroup>
          <div className="mt-4 flex gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
            <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              A skill is instructions your AI follows
              {scripts > 0 ? `, and these come with ${plural(scripts, "script")} it may run` : ""}.
              Nothing runs now. Add skills only from people you trust.
            </span>
          </div>
          {error ? (
            <div className="mt-2 text-xs text-destructive-foreground" role="alert">
              {error}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={count === 0 || pending}
            onClick={() => void add()}
            data-testid="setup-skill-import-add"
          >
            {pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {count === 0
              ? "Pick skills"
              : count === 1
                ? "Add skill"
                : `Add ${plural(count, "skill")}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
