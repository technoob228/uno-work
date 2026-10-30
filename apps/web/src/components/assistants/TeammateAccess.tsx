/**
 * What a teammate can use beyond its projects (track 3, Misha 16.10):
 * Connectors, Browser & logins, Keys & tokens, Skills.
 *
 * Two readers, one screen: each block is one plain line and one control
 * (All / Pick / None, or a few choices); picks a person makes show right
 * away; "Details" opens the technical part — scopes and MCP tools, where
 * the vault lives and who puts a secret in, the skills' paths. Uno's default
 * is full access to this computer: one line, the blocks behind "Limit…".
 *
 * Honest about the boundary (critics track 3): on a computer it shares with
 * you, these lists say what it uses, not a wall — it can still read any
 * file and is signed in wherever you are in that browser. A computer of its
 * own is the wall.
 */
import type { CredentialMetadata, EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  BlocksIcon,
  CheckIcon,
  ChevronRightIcon,
  GlobeIcon,
  KeyRoundIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { useSettings } from "../../hooks/useSettings";
import { listProjectSkills } from "../../lib/projectSkillsApi";
import { cn } from "../../lib/utils";
import { ensureLocalApi } from "../../localApi";
import { connectorItems, isSiteLogin, siteOf } from "../connectors/connectorsCatalog.logic";
import { SETUP_SKILLS } from "../setup/setupSkills";
import { shownProviders, useConnectorActions } from "../setup/steps/ConnectorsStep";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  APP_LEVEL_NAME,
  type AppLevel,
  type AssistantAccess,
  BROWSER_USE,
  type BrowserUse,
  FULL_ACCESS,
  type PickMode,
  type Picks,
  connectorLevel,
  connectorMode,
  connectorsLine,
  isFullAccess,
  pickedLine,
  pickedOf,
  picksMode,
  setConnectorLevel,
  setConnectorMode,
  setPicksMode,
  togglePicked,
} from "./assistantTeam.logic";

// ── Data ──────────────────────────────────────────────────────────────────

/**
 * The apps and servers as one list. `on`: the computer whose Uno Work asks
 * the console (the one the assistant works on); the window's by default.
 * The servers listed are the window's computer's own (`settings.mcpServers`).
 */
export function useConnectorItems(on?: EnvironmentId | null) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = on ?? primaryEnvironmentId;
  const actions = useConnectorActions(environmentId);
  const servers = useSettings((settings) => settings.mcpServers);
  const apps = shownProviders(actions.connectors.data?.connectors).map((meta) => {
    const connector = actions.byProvider.get(meta.provider);
    return {
      provider: meta.provider,
      name: meta.name,
      connected: connector?.connected === true,
      account: connector?.account ?? null,
      needsReconnect: connector?.needsReconnect,
    };
  });
  return {
    items: connectorItems({ apps, servers }),
    actions,
    loading: actions.connectors.isPending,
  };
}

export function useVaultEntries() {
  const enabled = useFeatureFlag("vault");
  const query = useQuery({
    queryKey: ["vault", "list"],
    queryFn: () => ensureLocalApi().vault.list(),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
  const entries: ReadonlyArray<CredentialMetadata> = query.data ?? [];
  return {
    enabled,
    loading: enabled && query.isPending,
    logins: entries.filter(isSiteLogin),
    secrets: entries.filter((entry) => !isSiteLogin(entry)),
  };
}

/** The skills in the projects of the computer it works on (not this window's). */
export function useProjectSkills(on: string | null) {
  const primary = usePrimaryEnvironmentId();
  const environmentId = on ?? primary;
  return useQuery({
    queryKey: ["project-skills", environmentId],
    queryFn: () => listProjectSkills({ environmentId: environmentId as EnvironmentId }),
    enabled: environmentId !== null,
    retry: false,
    staleTime: 60_000,
  });
}

// ── Pieces ────────────────────────────────────────────────────────────────

function Block(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly line: ReactNode;
  readonly control?: ReactNode;
  readonly details?: ReactNode;
  /** Shown right away, not under Details: the picks a person makes (passwords). */
  readonly picks?: ReactNode;
  readonly testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="border-t border-border/70 px-3 py-2.5 first:border-t-0"
      data-testid={props.testId}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          {props.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <span className="text-sm font-medium">{props.title}</span>
            {props.control}
          </div>
          <div className="text-xs leading-snug text-muted-foreground">{props.line}</div>
          {props.picks ? <div className="mt-1 flex flex-col gap-0.5">{props.picks}</div> : null}
          {props.details ? (
            <>
              <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                className="mt-1 inline-flex cursor-pointer items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <ChevronRightIcon
                  className={cn("size-3 transition-transform", open && "rotate-90")}
                />
                Details
              </button>
              {open ? <div className="mt-1.5 flex flex-col gap-0.5">{props.details}</div> : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CheckLine(props: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onToggle: () => void;
  readonly label: ReactNode;
  readonly tech?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={props.onToggle}
      className="flex w-full cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/50 disabled:cursor-default disabled:opacity-50"
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-[3px] border text-[9px] leading-none",
          props.checked ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {props.checked ? "✓" : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-foreground">{props.label}</span>
        {props.tech ? (
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {props.tech}
          </span>
        ) : null}
      </span>
    </button>
  );
}

const TechLine = (props: { readonly label: ReactNode; readonly tech: string }) => (
  <span className="flex gap-2 px-1.5 text-[11px]">
    <span className="w-28 shrink-0 truncate text-foreground">{props.label}</span>
    <span className="min-w-0 truncate font-mono text-muted-foreground">{props.tech}</span>
  </span>
);

/** All / Pick / None — no "off" that still lets things through (critics track 3). */
function ModeSwitch(props: {
  readonly value: PickMode;
  readonly onChange: (mode: PickMode) => void;
  readonly disabled: boolean;
  readonly label: string;
  readonly testId?: string;
}) {
  return (
    <ToggleGroup
      variant="outline"
      size="xs"
      value={[props.value]}
      disabled={props.disabled}
      aria-label={props.label}
      data-testid={props.testId}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "all" || next === "pick" || next === "none") props.onChange(next);
      }}
    >
      {(["all", "pick", "none"] as const).map((mode) => (
        <Toggle key={mode} value={mode} className="px-2 text-xs">
          {mode === "all" ? "All" : mode === "pick" ? "Pick" : "None"}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/** One app's level: No / Reads / Reads & changes — the daemon checks it on every call. */
function LevelSwitch(props: {
  readonly value: AppLevel;
  readonly onChange: (level: AppLevel) => void;
  readonly disabled: boolean;
  readonly label: string;
}) {
  return (
    <ToggleGroup
      variant="outline"
      size="xs"
      value={[props.value]}
      disabled={props.disabled}
      aria-label={props.label}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "none" || next === "read" || next === "write") props.onChange(next);
      }}
    >
      {(["none", "read", "write"] as const).map((level) => (
        <Toggle key={level} value={level} className="px-1.5 text-[11px]">
          {APP_LEVEL_NAME[level]}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/** Where it works, for the honest lines: next to you, or on a computer of its own. */
export interface AccessPlace {
  /** The computer whose projects and skills it works with. */
  readonly environmentId: string | null;
  readonly label: string;
  /** A computer of its own — the only real wall (decision 16.10). */
  readonly own: boolean;
  /** Your own computer (a Mac): it signs in to sites by asking you. */
  readonly mac: boolean;
}

const Note = (props: { readonly children: ReactNode }) => (
  <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
    <ShieldCheckIcon className="mt-px size-3 shrink-0" />
    <span>{props.children}</span>
  </p>
);

// ── The blocks ────────────────────────────────────────────────────────────

export function TeammateAccess(props: {
  readonly name: string;
  readonly access: AssistantAccess;
  readonly onChange: ((access: AssistantAccess) => void) | null;
  /** Full access reads as one line until "Limit…" (Uno's page and setup). */
  readonly foldWhenFull?: boolean;
  readonly place: AccessPlace;
  /** Its projects — the skills shown are theirs. */
  readonly projects: "all" | ReadonlyArray<string>;
  readonly className?: string;
  /**
   * Only the apps (the level per app is what Work enforces per assistant on
   * this computer today); the browser, saved logins, keys and skills are
   * one setting for every assistant here — said in one line instead.
   */
  readonly onlyConnectors?: boolean;
}) {
  const { access, onChange, name, place } = props;
  const navigate = useNavigate();
  const connectors = useConnectorItems(place.environmentId as EnvironmentId | null);
  const vault = useVaultEntries();
  const projectSkills = useProjectSkills(place.environmentId);
  const computerBrowser = useSettings((settings) => settings.browserAutomationLevel);
  const [limiting, setLimiting] = useState(false);
  const readOnly = onChange === null;
  const set = (patch: Partial<AssistantAccess>) => onChange?.({ ...access, ...patch });

  if (props.foldWhenFull && isFullAccess(access) && !limiting) {
    return (
      <div
        className={cn("flex items-start gap-2.5 px-3 py-2.5", props.className)}
        data-testid="teammate-access-full"
      >
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <ShieldCheckIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          {props.projects === "all" ? (
            <>
              <div className="text-sm font-medium">Full access to this computer</div>
              <div className="text-xs text-muted-foreground">
                Every project, connected app, browser login, key and skill here — like you.
              </div>
            </>
          ) : (
            // Audit 27.10 #12: its projects are limited above — say only what is full.
            <>
              <div className="text-sm font-medium">Every app in its projects</div>
              <div className="text-xs text-muted-foreground">
                Only its{" "}
                {props.projects.length === 1 ? "project" : `${props.projects.length} projects`};
                there it uses every connected app, browser login, key and skill.
              </div>
            </>
          )}
        </div>
        {readOnly ? null : (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setLimiting(true)}
            data-testid="teammate-access-limit"
          >
            Limit…
          </Button>
        )}
      </div>
    );
  }

  const apps = connectors.items.filter((item) => item.kind === "app" && item.connected);
  const servers = connectors.items.filter((item) => item.kind === "own");
  const appNames = apps.map((item) => ({ id: item.id, name: item.name }));
  const appIds = apps.map((item) => item.id);
  const loginNames = vault.logins.map((entry) => ({ id: entry.id, name: siteOf(entry.url) }));
  const secretNames = vault.secrets.map((entry) => ({ id: entry.id, name: entry.label }));
  const wanted = props.projects === "all" ? null : new Set(props.projects);
  const skills = (projectSkills.data?.skills ?? []).filter(
    (skill) => wanted === null || wanted.has(skill.project),
  );
  const personal = Object.values(SETUP_SKILLS);
  const mode = connectorMode(access.connectors);
  const vaultWhere = place.own
    ? `${place.label}'s own Uno Work`
    : `the Uno Work on ${place.label || "this computer"}`;

  const picksList = (input: {
    readonly picks: Picks;
    readonly entries: ReadonlyArray<CredentialMetadata>;
    readonly label: (entry: CredentialMetadata) => ReactNode;
    readonly onChange: (picks: Picks) => void;
    readonly disabled?: boolean;
  }) =>
    picksMode(input.picks) === "pick" && input.entries.length > 0
      ? input.entries.map((entry) => (
          <CheckLine
            key={entry.id}
            checked={pickedOf(input.picks, input.entries).some((item) => item.id === entry.id)}
            disabled={readOnly || input.disabled === true}
            onToggle={() =>
              input.onChange(
                togglePicked(
                  input.picks,
                  entry.id,
                  input.entries.map((item) => item.id),
                ),
              )
            }
            label={input.label(entry)}
          />
        ))
      : null;

  return (
    <div className={cn("flex flex-col", props.className)} data-testid="teammate-access">
      {props.foldWhenFull && limiting ? (
        <div className="flex items-start justify-between gap-2 border-b border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
          <span>
            Limit what {name} uses. It lives on this computer, so it can still read any file here —
            these lists say what it uses, not a wall.
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              set(FULL_ACCESS);
              setLimiting(false);
            }}
          >
            Back to full access
          </Button>
        </div>
      ) : null}

      {/* Connectors */}
      <Block
        testId="teammate-access-connectors"
        icon={<BlocksIcon className="size-3.5" />}
        title="Connectors"
        line={
          connectors.loading ? (
            "…"
          ) : apps.length === 0 ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              No apps connected yet.
              {readOnly ? null : (
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void navigate({ to: "/settings/connectors" })}
                    data-testid="teammate-connect-apps"
                  >
                    Connect apps
                  </Button>
                </>
              )}
            </span>
          ) : (
            connectorsLine(access.connectors, appNames)
          )
        }
        control={
          apps.length > 0 ? (
            <ModeSwitch
              value={mode}
              disabled={readOnly}
              label={`Which apps ${name} uses`}
              testId="teammate-access-connectors-mode"
              onChange={(next) =>
                set({ connectors: setConnectorMode(access.connectors, next, appIds) })
              }
            />
          ) : null
        }
        picks={
          apps.length === 0 ? null : mode === "all" ? (
            <div className="flex items-center gap-2 px-1.5 text-xs text-muted-foreground">
              Every app:
              <ToggleGroup
                variant="outline"
                size="xs"
                value={[access.connectors as string]}
                disabled={readOnly}
                onValueChange={(value) => {
                  const next = value[0];
                  if (next === "read" || next === "write") set({ connectors: next });
                }}
              >
                <Toggle value="write" className="px-1.5 text-[11px]">
                  Reads & changes
                </Toggle>
                <Toggle value="read" className="px-1.5 text-[11px]">
                  Reads only
                </Toggle>
              </ToggleGroup>
            </div>
          ) : mode === "pick" ? (
            apps.map((item) => (
              <div key={item.id} className="flex items-center gap-2 px-1.5 py-0.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground">
                    {item.name}
                    {item.account ? (
                      <span className="text-muted-foreground"> · {item.account}</span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {item.plain}
                  </span>
                </span>
                <LevelSwitch
                  value={connectorLevel(access.connectors, item.id)}
                  disabled={readOnly}
                  label={`${name} in ${item.name}`}
                  onChange={(level) =>
                    set({
                      connectors: setConnectorLevel(access.connectors, item.id, level, appIds),
                    })
                  }
                />
              </div>
            ))
          ) : null
        }
        details={
          connectors.items.length > 0 ? (
            <>
              {connectors.items.map((item) => (
                <TechLine
                  key={item.id}
                  label={item.connected ? item.name : `${item.name} · not connected`}
                  tech={item.tech}
                />
              ))}
              <Note>
                A scope is what the whole Uno account allows; the level here is checked by the
                computer’s Uno Work on every call — “Reads” lets through only tools that change
                nothing. The app’s token stays in your Uno account, not on the computer.
              </Note>
              {servers.length > 0 ? (
                <Note>
                  Servers you added ({servers.map((item) => item.name).join(", ")}) reach every chat
                  on this computer — they can’t be limited per assistant yet.
                </Note>
              ) : null}
              <button
                type="button"
                onClick={() => void navigate({ to: "/settings/connectors" })}
                className="mt-0.5 cursor-pointer self-start px-1.5 text-[11px] text-primary hover:underline"
              >
                Manage in Settings → Connectors
              </button>
            </>
          ) : null
        }
      />

      {props.onlyConnectors ? (
        <p
          className="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground"
          data-testid="teammate-access-shared-line"
        >
          Browser, saved logins, keys and skills are the same for every assistant on{" "}
          {place.label || "this computer"} for now — limits per assistant come later.
        </p>
      ) : (
        <TeammateAccessMore
          name={name}
          access={access}
          readOnly={readOnly}
          set={set}
          place={place}
          vault={vault}
          loginNames={loginNames}
          secretNames={secretNames}
          skills={skills}
          personal={personal}
          vaultWhere={vaultWhere}
          picksList={picksList}
          computerBrowser={computerBrowser}
          projectSkillsLoading={projectSkills.isLoading}
        />
      )}
    </div>
  );
}

/** Browser & logins, keys and skills (the mock's per-assistant blocks). */
function TeammateAccessMore(props: {
  readonly name: string;
  readonly access: AssistantAccess;
  readonly readOnly: boolean;
  readonly set: (patch: Partial<AssistantAccess>) => void;
  readonly place: AccessPlace;
  readonly vault: ReturnType<typeof useVaultEntries>;
  readonly loginNames: ReadonlyArray<{ id: string; name: string }>;
  readonly secretNames: ReadonlyArray<{ id: string; name: string }>;
  readonly skills: ReadonlyArray<{ name: string; project: string; path: string }>;
  readonly personal: ReadonlyArray<(typeof SETUP_SKILLS)[keyof typeof SETUP_SKILLS]>;
  readonly vaultWhere: string;
  readonly picksList: (input: {
    readonly picks: Picks;
    readonly entries: ReadonlyArray<CredentialMetadata>;
    readonly label: (entry: CredentialMetadata) => ReactNode;
    readonly onChange: (picks: Picks) => void;
    readonly disabled?: boolean;
  }) => ReactNode;
  readonly computerBrowser: unknown;
  readonly projectSkillsLoading: boolean;
}) {
  const {
    name,
    access,
    readOnly,
    set,
    place,
    vault,
    loginNames,
    secretNames,
    skills,
    personal,
    vaultWhere,
    picksList,
    computerBrowser,
  } = props;
  return (
    <>
      {/* Browser & logins */}
      <Block
        testId="teammate-access-browser"
        icon={<GlobeIcon className="size-3.5" />}
        title="Browser & logins"
        line={
          computerBrowser === "off" ? (
            "The browser is off for agents on this computer (Settings → Browser)."
          ) : (
            <>
              {BROWSER_USE.find((option) => option.id === access.browser)?.line}
              {access.browser === "off" ? null : (
                <>
                  {" "}
                  {place.own
                    ? `Its own browser on ${place.label}, without your sign-ins.`
                    : "Also sees sites you’re already signed in to in this browser."}{" "}
                  {vault.logins.length === 0
                    ? "No saved logins yet."
                    : `Saved logins: ${pickedLine(access.logins, loginNames, {
                        all: "every saved site",
                        none: "none — it asks you",
                      })}.`}
                </>
              )}
            </>
          )
        }
        control={
          <ToggleGroup
            variant="outline"
            size="xs"
            value={[access.browser]}
            disabled={readOnly}
            onValueChange={(value) => {
              const next = value[0] as BrowserUse | undefined;
              if (next && BROWSER_USE.some((option) => option.id === next)) set({ browser: next });
            }}
          >
            {BROWSER_USE.map((option) => (
              <Toggle
                key={option.id}
                value={option.id}
                aria-label={option.line}
                className="px-2 text-xs"
              >
                {option.name}
              </Toggle>
            ))}
          </ToggleGroup>
        }
        picks={
          access.browser === "off" || vault.logins.length === 0 ? null : (
            <>
              <div className="flex items-center gap-2 px-1.5 text-xs text-muted-foreground">
                Saved logins:
                <ModeSwitch
                  value={picksMode(access.logins)}
                  disabled={readOnly}
                  label={`Which saved logins ${name} uses`}
                  onChange={(next) =>
                    set({
                      logins: setPicksMode(
                        access.logins,
                        next,
                        vault.logins.map((entry) => entry.id),
                      ),
                    })
                  }
                />
              </div>
              {picksList({
                picks: access.logins,
                entries: vault.logins,
                label: (entry) => (
                  <>
                    {siteOf(entry.url)}{" "}
                    <span className="text-muted-foreground">· {entry.username}</span>
                  </>
                ),
                onChange: (logins) => set({ logins }),
              })}
            </>
          )
        }
        details={
          <>
            {vault.logins.map((entry) => (
              <TechLine
                key={entry.id}
                label={siteOf(entry.url)}
                tech={`credential ${entry.id} · browser_command {login: "${siteOf(entry.url)}"}`}
              />
            ))}
            <Note>
              {place.mac
                ? "On your Mac it doesn’t type passwords: it asks you to sign in. "
                : `Uno Work on ${place.label || "this computer"} types the saved password into the page itself; the AI only learns “signed in” or not. `}
              2FA codes and captchas come to you in Needs you. “Fill” in the panel is yours only.
            </Note>
            <Note>
              Browser profile:{" "}
              {place.own
                ? `its own on ${place.label} — none of your cookies.`
                : "shared with you on this computer (Settings → Browser) — your sign-ins included."}
            </Note>
          </>
        }
      />

      {/* Keys & tokens */}
      <Block
        testId="teammate-access-vault"
        icon={<KeyRoundIcon className="size-3.5" />}
        title="Keys & tokens"
        line={
          !vault.enabled ? (
            "Credentials are off on this computer."
          ) : vault.secrets.length === 0 ? (
            "No keys saved yet — keys are passwords for programs (API keys, tokens)."
          ) : (
            <>
              Can use{" "}
              {pickedLine(access.secrets, secretNames, {
                all: "every saved key",
                none: "none — it asks you when it needs one",
              })}
              . The AI doesn’t get the value as text, but a command it runs can use it — tick only
              keys you’re fine letting it act with.
            </>
          )
        }
        control={
          vault.secrets.length > 0 ? (
            <ModeSwitch
              value={picksMode(access.secrets)}
              disabled={readOnly}
              label={`Which keys ${name} uses`}
              testId="teammate-access-vault-mode"
              onChange={(next) =>
                set({
                  secrets: setPicksMode(
                    access.secrets,
                    next,
                    vault.secrets.map((entry) => entry.id),
                  ),
                })
              }
            />
          ) : null
        }
        picks={picksList({
          picks: access.secrets,
          entries: vault.secrets,
          label: (entry) => entry.label,
          onChange: (secrets) => set({ secrets }),
        })}
        details={
          vault.secrets.length > 0 ? (
            <>
              {vault.secrets.map((entry) => (
                <TechLine key={entry.id} label={entry.label} tech={`credential ${entry.id}`} />
              ))}
              <Note>
                Kept by {vaultWhere}: names in credentials.json, values in a file only it can read
                (0600) — not in the cloud unless you turn on Sync in Credentials. It puts the value
                into the command and scrubs it from the output; a command can still print or send
                it.
              </Note>
              {place.own ? (
                <Note>
                  On its own computer it has only that computer’s keys — your Mac’s stay there
                  unless Sync is on.
                </Note>
              ) : null}
            </>
          ) : null
        }
      />

      {/* Skills */}
      <Block
        testId="teammate-access-skills"
        icon={<SparklesIcon className="size-3.5" />}
        title="Skills"
        line={
          <>
            {access.projectSkills
              ? skills.length > 0
                ? `Follows the skills in its projects (${skills.length})`
                : "Follows the skills in its projects (none there yet)"
              : "Ignores the skills in its projects"}
            {access.personalSkills.length > 0
              ? ` + its own: ${access.personalSkills
                  .map((id) => personal.find((skill) => skill.id === id)?.name ?? id)
                  .join(", ")}`
              : ""}
            .
          </>
        }
        control={
          <Switch
            aria-label={`${name} follows the skills in its projects`}
            checked={access.projectSkills}
            disabled={readOnly}
            onCheckedChange={(on) => set({ projectSkills: on })}
          />
        }
        picks={
          <div className="flex flex-wrap items-center gap-1 px-1.5">
            <span className="text-[11px] text-muted-foreground">Its own:</span>
            {personal.map((skill) => {
              const on = access.personalSkills.includes(skill.id);
              return (
                <Toggle
                  key={skill.id}
                  variant="outline"
                  size="xs"
                  className={cn(
                    "px-2 text-xs",
                    on
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "text-muted-foreground",
                  )}
                  pressed={on}
                  disabled={readOnly}
                  title={skill.description}
                  onPressedChange={(next) =>
                    set({
                      personalSkills: next
                        ? [...access.personalSkills, skill.id]
                        : access.personalSkills.filter((id) => id !== skill.id),
                    })
                  }
                >
                  {on ? <CheckIcon className="size-3" /> : null}
                  {skill.name}
                </Toggle>
              );
            })}
          </div>
        }
        details={
          <>
            <span className="px-1.5 text-[11px] font-medium text-muted-foreground">
              In its projects on {place.label || "this computer"}
            </span>
            {skills.length === 0 ? (
              <span className="px-1.5 text-xs text-muted-foreground">
                A project’s skills are folders with a SKILL.md in .claude/skills/.
              </span>
            ) : (
              skills.map((skill) => (
                <div key={`${skill.project}/${skill.name}`} className="px-1.5 py-0.5">
                  <span className="block truncate text-xs">
                    {skill.name} <span className="text-muted-foreground">· {skill.project}</span>
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {place.label || "this computer"}:{skill.project}/{skill.path}
                  </span>
                </div>
              ))
            )}
          </>
        }
      />
    </>
  );
}
