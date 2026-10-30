/**
 * "Applying settings for <All projects> on <computer>", at the top of a
 * settings page. Ported from T3 Code. Pages where nothing can be picked get
 * one plain line instead (`SettingsOwnerLine`).
 *
 * @module components/settings/SettingsScopeSentence
 */
import { CheckIcon, ChevronDownIcon, LayersIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ProjectFavicon } from "../ProjectFavicon";
import { MACHINE_KIND_ICON } from "../machineKindIcons";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { type ScopedEnvironment, useOptionalSettingsScope } from "./SettingsScopeContext";
import { MachineStatusDot } from "./SettingsScopeSwitcher";
import { settingsOwnerLine, type SettingsPageOwner } from "./settingsPageScope";
import {
  ALL_COMPUTERS_VALUE,
  ALL_PROJECTS_VALUE,
  projectsForComputer,
  selectComputerAxis,
  selectProjectAxis,
} from "./settingsScope";

interface ScopeOption {
  readonly value: string;
  readonly label: string;
  readonly secondary?: string;
  readonly icon?: ReactNode;
  readonly trailing?: ReactNode;
}

function ScopeOptionLabel({ option }: { readonly option: ScopeOption }) {
  return (
    <>
      {option.icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{option.label}</span>
        {option.secondary ? (
          <span className="block truncate text-xs text-muted-foreground">{option.secondary}</span>
        ) : null}
      </span>
      {option.trailing}
    </>
  );
}

function ScopeMenu({
  ariaLabel,
  icon,
  label,
  value,
  options,
  allOption,
  searchLabel,
  onChange,
}: {
  readonly ariaLabel: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: string;
  readonly options: readonly ScopeOption[];
  readonly allOption: ScopeOption | null;
  readonly searchLabel: string;
  readonly onChange: (next: string) => void;
}) {
  const [query, setQuery] = useState("");
  const searchable = options.length > 6;
  const Trigger = searchable ? ComboboxTrigger : MenuTrigger;
  const trigger = (
    <Trigger
      aria-label={`${ariaLabel}: ${label}`}
      render={<Button variant="outline" size="xs" />}
      className="min-w-0 max-w-64"
    >
      {icon}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDownIcon
        aria-hidden
        strokeWidth={1.75}
        className="-me-0.5 size-3.5 shrink-0 text-muted-foreground opacity-70"
      />
    </Trigger>
  );
  const choices = allOption ? [allOption, ...options] : [...options];
  if (searchable) {
    const needle = query.trim().toLowerCase();
    const filteredItems = choices.filter((option) =>
      `${option.label} ${option.secondary ?? ""}`.toLowerCase().includes(needle),
    );
    return (
      <Combobox
        items={choices}
        filteredItems={filteredItems}
        filter={null}
        autoHighlight
        itemToStringLabel={(option) => option.label}
        isItemEqualToValue={(a, b) => a.value === b.value}
        value={choices.find((option) => option.value === value) ?? null}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(option) => {
          if (option) onChange(option.value);
        }}
      >
        {trigger}
        <ComboboxPopup align="start" className="w-80">
          <ComboboxSearchInput
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>Nothing found.</ComboboxEmpty>
          <ComboboxList>
            {(option: ScopeOption) => (
              <ComboboxItem key={option.value} value={option}>
                <ScopeOptionLabel option={option} />
                {option.value === value ? (
                  <CheckIcon aria-hidden className="size-3.5 shrink-0" />
                ) : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  }
  return (
    <Menu>
      {trigger}
      <MenuPopup align="start">
        <div className="w-72 max-w-full">
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (typeof next === "string") onChange(next);
            }}
          >
            {allOption ? (
              <>
                <MenuRadioItem value={allOption.value} closeOnClick>
                  <span className="flex min-w-0 items-center gap-2">
                    <ScopeOptionLabel option={allOption} />
                  </span>
                </MenuRadioItem>
                {options.length > 0 ? <MenuSeparator /> : null}
              </>
            ) : null}
            {options.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <ScopeOptionLabel option={option} />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </div>
      </MenuPopup>
    </Menu>
  );
}

function computerIcon(environment: ScopedEnvironment) {
  const Icon = MACHINE_KIND_ICON[environment.kind];
  return <Icon aria-hidden className="size-3.5 shrink-0" />;
}

function computerOption(environment: ScopedEnvironment): ScopeOption {
  return {
    value: environment.environmentId,
    label: environment.label,
    icon: computerIcon(environment),
    trailing: (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <MachineStatusDot status={environment.status} />
        {environment.statusLabel}
      </span>
    ),
  };
}

function ComputerAxis({ allowAll }: { readonly allowAll: boolean }) {
  const context = useOptionalSettingsScope();
  if (context === null) return null;
  const { allEnvironments, groups, search, selectScope, singleComputer } = context;
  const selected = allEnvironments.find((entry) => entry.environmentId === search.machine);
  const project = groups.find((group) => group.projectKey === search.project);
  const memberIds = project
    ? new Set(project.memberProjects.map((member) => member.environmentId))
    : null;
  const options = allEnvironments.filter(
    (entry) => memberIds === null || memberIds.has(entry.environmentId),
  );
  // One computer: nothing to choose, so the sentence just names it.
  if (singleComputer) {
    const only = allEnvironments[0];
    return only ? (
      <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground">
        {computerIcon(only)}
        <span className="truncate">{only.label}</span>
      </span>
    ) : null;
  }
  return (
    <ScopeMenu
      ariaLabel="Computer"
      icon={selected ? computerIcon(selected) : <LayersIcon aria-hidden className="size-3.5" />}
      label={selected?.label ?? (search.machine ? "Unavailable computer" : "All computers")}
      value={search.machine ?? ALL_COMPUTERS_VALUE}
      onChange={(next) => selectScope(selectComputerAxis(search, next))}
      searchLabel="Search computers"
      allOption={
        allowAll
          ? {
              value: ALL_COMPUTERS_VALUE,
              label: "All computers",
              icon: <LayersIcon aria-hidden className="size-3.5 shrink-0" />,
            }
          : null
      }
      options={options.map(computerOption)}
    />
  );
}

function ProjectAxis() {
  const context = useOptionalSettingsScope();
  if (context === null) return null;
  const { groups, search, selectScope, allEnvironments, singleComputer } = context;
  const selected = groups.find((group) => group.projectKey === search.project);
  const projects = projectsForComputer(groups, search.machine);
  const labelOf = (id: string) =>
    allEnvironments.find((entry) => entry.environmentId === id)?.label ?? null;
  return (
    <ScopeMenu
      ariaLabel="Project"
      icon={
        selected ? (
          <ProjectFavicon
            environmentId={selected.environmentId}
            cwd={selected.cwd}
            name={selected.displayName}
            className="size-3.5 shrink-0"
          />
        ) : null
      }
      label={selected?.displayName ?? (search.project ? "Unavailable project" : "All projects")}
      value={search.project ?? ALL_PROJECTS_VALUE}
      onChange={(next) => selectScope(selectProjectAxis(search, next))}
      searchLabel="Search projects"
      allOption={{ value: ALL_PROJECTS_VALUE, label: "All projects" }}
      options={projects.map((group) => ({
        value: group.projectKey,
        label: group.displayName,
        ...(singleComputer
          ? {}
          : {
              secondary: group.memberProjects
                .flatMap((member) => labelOf(member.environmentId) ?? [])
                .join(", "),
            }),
        icon: (
          <ProjectFavicon
            environmentId={group.environmentId}
            cwd={group.cwd}
            name={group.displayName}
            className="size-3.5 shrink-0"
          />
        ),
      }))}
    />
  );
}

const SENTENCE_CLASS =
  "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground";

export function SettingsScopeSentence({ mode }: { readonly mode: "scoped" | "computer" }) {
  const context = useOptionalSettingsScope();
  if (context === null) return null;
  const { groups, singleComputer, unreachableEnvironments, wideScope, scope } = context;
  // Nothing to choose: a person with one computer and no projects sees no sentence.
  if (mode === "scoped" && singleComputer && groups.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="settings-scope-sentence">
      <div className={SENTENCE_CLASS}>
        <span className="shrink-0">Applying settings</span>
        {mode === "scoped" ? (
          <>
            <span className="shrink-0">for</span>
            <ProjectAxis />
          </>
        ) : null}
        <span className="shrink-0">on</span>
        <ComputerAxis allowAll={mode === "scoped"} />
      </div>
      {scope.kind === "unavailable" ? (
        <p role="status" className="text-xs text-muted-foreground">
          {scope.message}
        </p>
      ) : wideScope && unreachableEnvironments.length > 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          {unreachableEnvironments.map((entry) => entry.label).join(", ")}{" "}
          {unreachableEnvironments.length === 1 ? "is" : "are"} off and won't get changes made here.
        </p>
      ) : null}
    </div>
  );
}

/** One line for pages that belong to the account, a device or one computer. */
export function SettingsOwnerLine({
  owner,
  computerLabel,
}: {
  readonly owner: SettingsPageOwner;
  readonly computerLabel: string;
}) {
  return (
    <p className="text-sm text-muted-foreground" data-testid="settings-owner-line">
      {settingsOwnerLine(owner, computerLabel)}
    </p>
  );
}
