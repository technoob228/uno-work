/**
 * "Found in your project · 3" / "Already on this computer · 5": skills the
 * agents here already read (skillImport.ts). On by being there; a project's
 * plain `skills/` folder isn't read by any agent, so those get "Turn on".
 */
import type { FoundSkill } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, FolderIcon, Loader2Icon, MonitorIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { agentsLine } from "./skillImport";

const COLLAPSED_ROWS = 4;

function FoundRow({
  skill,
  onTurnOn,
  turningOn,
}: {
  skill: FoundSkill;
  onTurnOn: ((skill: FoundSkill) => void) | undefined;
  turningOn: boolean;
}) {
  const inactive = skill.agents.length === 0;
  return (
    <div
      className="flex items-start gap-3 border-t border-border px-4 py-2.5 sm:px-5"
      data-testid={`setup-found-skill-${skill.name}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
          <span className="truncate">{skill.name}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {inactive
              ? "in skills/ · no AI reads this folder"
              : skill.plugin
                ? `plugin ${skill.plugin} · ${agentsLine(skill.agents)}`
                : agentsLine(skill.agents)}
          </span>
        </div>
        {skill.description ? (
          <div
            className="mt-0.5 line-clamp-1 text-xs text-muted-foreground"
            title={skill.description}
          >
            {skill.description}
          </div>
        ) : null}
      </div>
      {inactive ? (
        <Button
          size="xs"
          variant="outline"
          disabled={!onTurnOn || turningOn}
          onClick={() => onTurnOn?.(skill)}
        >
          {turningOn ? <Loader2Icon className="size-3 animate-spin" /> : null}
          Turn on
        </Button>
      ) : (
        <span
          className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success-foreground"
          title={skill.paths.join("\n")}
        >
          <CheckIcon className="size-3" />
          On
        </span>
      )}
    </div>
  );
}

function FoundGroup({
  title,
  icon: Icon,
  skills,
  onTurnOn,
  turningOn,
}: {
  title: string;
  icon: typeof FolderIcon;
  skills: ReadonlyArray<FoundSkill>;
  onTurnOn?: (skill: FoundSkill) => void;
  turningOn?: string | null;
}) {
  const [all, setAll] = useState(false);
  if (skills.length === 0) return null;
  const shown = all ? skills : skills.slice(0, COLLAPSED_ROWS);
  return (
    <div>
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 text-sm font-medium sm:px-5">
        <Icon className="size-4 text-muted-foreground" />
        {title}
        <span className="text-xs font-normal text-muted-foreground">{skills.length}</span>
      </div>
      {shown.map((skill) => (
        <FoundRow
          key={`${skill.plugin ?? ""}:${skill.name}`}
          skill={skill}
          onTurnOn={onTurnOn}
          turningOn={turningOn === skill.name}
        />
      ))}
      {skills.length > COLLAPSED_ROWS ? (
        <button
          type="button"
          onClick={() => setAll((value) => !value)}
          className="flex w-full items-center gap-1 border-t border-border px-4 py-2 text-xs text-muted-foreground hover:text-foreground sm:px-5"
        >
          <ChevronDownIcon className={cn("size-3.5 transition-transform", all && "rotate-180")} />
          {all ? "Show fewer" : `Show all ${skills.length}`}
        </button>
      ) : null}
    </div>
  );
}

export function SkillsFound({
  project,
  computer,
  projectName,
  onTurnOn,
  turningOn,
}: {
  project: ReadonlyArray<FoundSkill>;
  computer: ReadonlyArray<FoundSkill>;
  projectName: string | null;
  onTurnOn: (skill: FoundSkill) => void;
  turningOn: string | null;
}) {
  if (project.length === 0 && computer.length === 0) return null;
  return (
    <div
      className="mb-3 overflow-hidden rounded-2xl border border-border"
      data-testid="setup-found-skills"
    >
      <div className="px-4 pt-3 text-xs text-muted-foreground sm:px-5">
        Already here. Your AI uses these without setup.
      </div>
      <FoundGroup
        title={projectName ? `Found in ${projectName}` : "Found in your project"}
        icon={FolderIcon}
        skills={project}
        onTurnOn={onTurnOn}
        turningOn={turningOn}
      />
      <FoundGroup title="On this computer" icon={MonitorIcon} skills={computer} />
    </div>
  );
}
