/**
 * "Found in your project · 3" / "On this computer · 5": skills the agents
 * here already read (skillImport.ts), each with a tick. Unticked = its
 * folders moved to `<skills folder>-off/`, no agent sees it, the files stay;
 * ticking moves them back. Claude Code plugins are one row each — their
 * skills can only go off with the plugin. A project's plain `skills/` folder
 * isn't read by any agent, so those get "Turn on".
 */
import type { FoundSkill, SkillAgent } from "@t3tools/contracts";
import { ChevronDownIcon, FolderIcon, Loader2Icon, MonitorIcon, PuzzleIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  agentsLine,
  type FoundPlugin,
  isUnread,
  offFolderLine,
  SKILL_AGENT_LABEL,
} from "./skillImport";

const COLLAPSED_ROWS = 4;

export interface FoundSkillsActions {
  readonly installed: ReadonlySet<SkillAgent> | null;
  readonly home: string | null;
  readonly projectPath: string | null;
  /** Row key while its change is on the way. */
  readonly pending: string | null;
  readonly onToggle: (skill: FoundSkill, enabled: boolean) => void;
  readonly onTogglePlugin: (plugin: FoundPlugin, enabled: boolean) => void;
  readonly onTurnOn: (skill: FoundSkill) => void;
}

export const foundRowKey = (skill: FoundSkill) => `${skill.scope}:${skill.paths[0] ?? skill.name}`;

function nativeOffLine(
  skill: FoundSkill,
  installed: ReadonlySet<SkillAgent> | null,
): string | null {
  const off = installed ? skill.offIn.filter((agent) => installed.has(agent)) : skill.offIn;
  if (off.length === 0) return null;
  return `off in ${off.map((agent) => SKILL_AGENT_LABEL[agent]).join(" and ")} settings`;
}

function Row({
  title,
  meta,
  description,
  checked,
  pending,
  onChange,
  action,
  testId,
  dim,
}: {
  title: string;
  meta: string;
  description: string;
  checked: boolean | null;
  pending: boolean;
  onChange?: (checked: boolean) => void;
  action?: React.ReactNode;
  testId: string;
  dim: boolean;
}) {
  const body = (
    <>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {pending ? (
          <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
        ) : checked !== null ? (
          <Checkbox
            checked={checked}
            onCheckedChange={(value) => onChange?.(value === true)}
            aria-label={checked ? `Turn off ${title}` : `Turn on ${title}`}
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
          <span className={cn("truncate", dim && "text-muted-foreground")}>{title}</span>
          <span className="text-xs font-normal text-muted-foreground">{meta}</span>
        </span>
        {description ? (
          <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground" title={description}>
            {description}
          </span>
        ) : null}
      </span>
    </>
  );
  return (
    <div
      className="flex items-start gap-3 border-t border-border px-4 py-2.5 sm:px-5"
      data-testid={testId}
    >
      {checked !== null && !pending ? (
        <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">{body}</label>
      ) : (
        <span className="flex min-w-0 flex-1 items-start gap-3">{body}</span>
      )}
      {action}
    </div>
  );
}

function SkillRow({ skill, actions }: { skill: FoundSkill; actions: FoundSkillsActions }) {
  const key = foundRowKey(skill);
  if (isUnread(skill)) {
    return (
      <Row
        title={skill.name}
        meta="in skills/ · no AI reads this folder"
        description={skill.description}
        checked={null}
        pending={false}
        dim
        testId={`setup-found-skill-${skill.name}`}
        action={
          <Button
            size="xs"
            variant="outline"
            disabled={actions.pending === key}
            onClick={() => actions.onTurnOn(skill)}
          >
            {actions.pending === key ? <Loader2Icon className="size-3 animate-spin" /> : null}
            Turn on
          </Button>
        }
      />
    );
  }
  const on = skill.enabled !== false;
  const nativeOff = nativeOffLine(skill, actions.installed);
  const readers = agentsLine(skill.agents, actions.installed);
  const meta = on
    ? [readers || "no AI here reads it", nativeOff].filter(Boolean).join(" · ")
    : `Off · kept in ${offFolderLine(skill, actions.home, actions.projectPath) ?? "the -off folder"} · tick to turn back on`;
  return (
    <Row
      title={skill.name}
      meta={meta}
      description={skill.description}
      checked={on}
      pending={actions.pending === key}
      onChange={(value) => actions.onToggle(skill, value)}
      dim={!on}
      testId={`setup-found-skill-${skill.name}`}
    />
  );
}

function PluginRow({ plugin, actions }: { plugin: FoundPlugin; actions: FoundSkillsActions }) {
  const key = `plugin:${plugin.pluginId}`;
  const names = plugin.skills.map((skill) => skill.name);
  const list =
    names.length > 3
      ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`
      : names.join(", ");
  return (
    <Row
      title={plugin.name}
      meta={
        plugin.enabled
          ? `Claude Code plugin · ${names.length} skill${names.length === 1 ? "" : "s"} · on or off together`
          : "Claude Code plugin · off · tick to turn back on"
      }
      description={list}
      checked={plugin.enabled}
      pending={actions.pending === key}
      onChange={(value) => actions.onTogglePlugin(plugin, value)}
      dim={!plugin.enabled}
      testId={`setup-found-plugin-${plugin.name}`}
    />
  );
}

function Group({
  title,
  icon: Icon,
  count,
  rows,
}: {
  title: string;
  icon: typeof FolderIcon;
  count: number;
  rows: ReadonlyArray<React.ReactNode>;
}) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, COLLAPSED_ROWS);
  return (
    <div>
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 text-sm font-medium sm:px-5">
        <Icon className="size-4 text-muted-foreground" />
        {title}
        <span className="text-xs font-normal text-muted-foreground">{count}</span>
      </div>
      {shown}
      {rows.length > COLLAPSED_ROWS ? (
        <button
          type="button"
          onClick={() => setAll((value) => !value)}
          className="flex w-full items-center gap-1 border-t border-border px-4 py-2 text-xs text-muted-foreground hover:text-foreground sm:px-5"
        >
          <ChevronDownIcon className={cn("size-3.5 transition-transform", all && "rotate-180")} />
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}

export function SkillsFound({
  project,
  computer,
  plugins,
  projectName,
  actions,
}: {
  project: ReadonlyArray<FoundSkill>;
  computer: ReadonlyArray<FoundSkill>;
  plugins: ReadonlyArray<FoundPlugin>;
  projectName: string | null;
  actions: FoundSkillsActions;
}) {
  if (project.length === 0 && computer.length === 0 && plugins.length === 0) return null;
  const row = (skill: FoundSkill) => (
    <SkillRow key={foundRowKey(skill)} skill={skill} actions={actions} />
  );
  return (
    <div
      className="mb-3 overflow-hidden rounded-2xl border border-border"
      data-testid="setup-found-skills"
    >
      <div className="px-4 pt-3 text-xs text-muted-foreground sm:px-5">
        Already here, and your AI uses them. Untick one to turn it off: the files stay.
      </div>
      <Group
        title={projectName ? `Found in ${projectName}` : "Found in your project"}
        icon={FolderIcon}
        count={project.length}
        rows={project.map(row)}
      />
      <Group
        title="On this computer"
        icon={MonitorIcon}
        count={computer.length}
        rows={computer.map(row)}
      />
      <Group
        title="Claude Code plugins"
        icon={PuzzleIcon}
        count={plugins.length}
        rows={plugins.map((plugin) => (
          <PluginRow key={plugin.pluginId} plugin={plugin} actions={actions} />
        ))}
      />
    </div>
  );
}
