/**
 * What a teammate can use beyond its projects (track 3, Misha 16.10):
 * Connectors, Browser & logins, Passwords (vault), Skills.
 *
 * Two readers, one screen: each block is one plain line and one control
 * (a switch or three choices); "Details" opens the technical part — the
 * connector's scopes and MCP tools, the vault entries' names, the skills'
 * paths. Uno's default is full access to this computer: that is one line,
 * and the blocks stay behind "Limit…" — the advanced part is clearly advanced.
 *
 * Sources of truth: Settings → Connectors (the apps and servers of your own),
 * Credentials (the vault), the projects' folders (their skills) and the skill
 * catalog (its own skills). Secrets never reach the AI as text: logins are
 * filled into the page by Uno, keys go into commands by name.
 */
import type { CredentialMetadata, EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  BlocksIcon,
  ChevronRightIcon,
  GlobeIcon,
  KeyRoundIcon,
  Loader2Icon,
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
import { PROVIDERS, useConnectorActions } from "../setup/steps/ConnectorsStep";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  type AssistantAccess,
  BROWSER_USE,
  FULL_ACCESS,
  isFullAccess,
  pickedLine,
  pickedOf,
  togglePicked,
} from "./assistantTeam.logic";

// ── Data ──────────────────────────────────────────────────────────────────

export function useConnectorItems() {
  const environmentId = usePrimaryEnvironmentId();
  const actions = useConnectorActions(environmentId);
  const servers = useSettings((settings) => settings.mcpServers);
  const apps = PROVIDERS.map((meta) => {
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

export function useProjectSkills() {
  const environmentId = usePrimaryEnvironmentId();
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
  readonly className?: string;
}) {
  const { access, onChange, name } = props;
  const navigate = useNavigate();
  const connectors = useConnectorItems();
  const vault = useVaultEntries();
  const projectSkills = useProjectSkills();
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
          <div className="text-sm font-medium">Full access to this computer</div>
          <div className="text-xs text-muted-foreground">
            Every project, connected app, browser login, password and skill here — like you.
          </div>
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

  const connected = connectors.items.filter((item) => item.connected);
  const connectorNames = connected.map((item) => ({ id: item.id, name: item.name }));
  const loginNames = vault.logins.map((entry) => ({ id: entry.id, name: siteOf(entry.url) }));
  const secretNames = vault.secrets.map((entry) => ({ id: entry.id, name: entry.label }));
  const skills = projectSkills.data?.skills ?? [];
  const personal = Object.values(SETUP_SKILLS);

  return (
    <div className={cn("flex flex-col", props.className)} data-testid="teammate-access">
      {props.foldWhenFull && limiting ? (
        <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
          Limit what {name} can use — the rest of this computer stays open to it.
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
          ) : connected.length === 0 ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              No apps connected on this computer yet.
              {readOnly ? null : (
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={connectors.actions.pending !== null}
                    onClick={() => void connectors.actions.connect("github")}
                    data-testid="teammate-connect-github"
                  >
                    {connectors.actions.pending?.provider === "github" ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : null}
                    Connect GitHub
                  </Button>
                  <button
                    type="button"
                    onClick={() => void navigate({ to: "/settings/connectors" })}
                    className="cursor-pointer text-primary hover:underline"
                  >
                    Others in Settings
                  </button>
                </>
              )}
            </span>
          ) : (
            <>
              Works in{" "}
              {pickedLine(access.connectors, connectorNames, {
                all: "every connected app",
                none: "no apps",
              })}
              .
            </>
          )
        }
        control={
          connected.length > 0 ? (
            <Switch
              aria-label={`${name} can use every connected app`}
              checked={access.connectors === "all"}
              disabled={readOnly}
              onCheckedChange={(on) => set({ connectors: on ? "all" : [] })}
            />
          ) : null
        }
        details={
          connectors.items.length > 0 ? (
            <>
              {connectors.items.map((item) => (
                <CheckLine
                  key={item.id}
                  checked={
                    item.connected &&
                    pickedOf(access.connectors, connected).some((c) => c.id === item.id)
                  }
                  disabled={readOnly || !item.connected}
                  onToggle={() =>
                    set({
                      connectors: togglePicked(
                        access.connectors,
                        item.id,
                        connected.map((c) => c.id),
                      ),
                    })
                  }
                  label={
                    <>
                      {item.name}
                      {item.connected ? (
                        item.account ? (
                          <span className="text-muted-foreground"> · {item.account}</span>
                        ) : null
                      ) : (
                        <span className="text-muted-foreground"> · not connected</span>
                      )}
                    </>
                  }
                  tech={item.tech}
                />
              ))}
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
              {BROWSER_USE.find((option) => option.id === access.browser)?.line}{" "}
              {access.browser === "off"
                ? null
                : vault.logins.length === 0
                  ? "No saved logins yet."
                  : `Signs in to ${pickedLine(access.logins, loginNames, {
                      all: "every saved site",
                      none: "no sites — it asks you",
                    })}.`}
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
              const next = value[0];
              if (next === "off" || next === "safe" || next === "full") set({ browser: next });
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
        details={
          <>
            {vault.logins.length === 0 ? (
              <span className="px-1.5 text-xs text-muted-foreground">
                Saved logins come from Credentials and the browser’s “Save password”.
              </span>
            ) : (
              vault.logins.map((entry) => (
                <CheckLine
                  key={entry.id}
                  checked={pickedOf(access.logins, vault.logins).some(
                    (item) => item.id === entry.id,
                  )}
                  disabled={readOnly || access.browser === "off"}
                  onToggle={() =>
                    set({
                      logins: togglePicked(
                        access.logins,
                        entry.id,
                        vault.logins.map((item) => item.id),
                      ),
                    })
                  }
                  label={
                    <>
                      {siteOf(entry.url)}{" "}
                      <span className="text-muted-foreground">· {entry.username}</span>
                    </>
                  }
                  tech={`vault › ${entry.label} · filled by Uno (vault.fill)`}
                />
              ))
            )}
            <Note>Uno types the password into the page itself — the AI never reads it.</Note>
          </>
        }
      />

      {/* Passwords (vault) */}
      <Block
        testId="teammate-access-vault"
        icon={<KeyRoundIcon className="size-3.5" />}
        title="Passwords (vault)"
        line={
          !vault.enabled ? (
            "Credentials are off on this computer."
          ) : vault.secrets.length === 0 ? (
            "No keys or tokens saved yet."
          ) : (
            <>
              Can use{" "}
              {pickedLine(access.secrets, secretNames, {
                all: "every saved key",
                none: "none — it asks you when it needs one",
              })}
              . It never sees them.
            </>
          )
        }
        control={
          vault.secrets.length > 0 ? (
            <Switch
              aria-label={`${name} can use every saved key`}
              checked={access.secrets === "all"}
              disabled={readOnly}
              onCheckedChange={(on) => set({ secrets: on ? "all" : [] })}
            />
          ) : null
        }
        details={
          vault.secrets.length > 0 ? (
            <>
              {vault.secrets.map((entry) => (
                <CheckLine
                  key={entry.id}
                  checked={pickedOf(access.secrets, vault.secrets).some(
                    (item) => item.id === entry.id,
                  )}
                  disabled={readOnly}
                  onToggle={() =>
                    set({
                      secrets: togglePicked(
                        access.secrets,
                        entry.id,
                        vault.secrets.map((item) => item.id),
                      ),
                    })
                  }
                  label={entry.label}
                  tech={`vault › ${entry.id}${entry.username ? ` · ${entry.username}` : ""}`}
                />
              ))}
              <Note>
                A key goes straight into the command that needs it; the AI sees only its name, and
                the value is masked in the chat.
              </Note>
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
                ? `Uses the skills in its projects (${skills.length})`
                : "Uses the skills in its projects (none yet)"
              : "Doesn't use the skills in its projects"}
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
            aria-label={`${name} uses the skills in its projects`}
            checked={access.projectSkills}
            disabled={readOnly}
            onCheckedChange={(on) => set({ projectSkills: on })}
          />
        }
        details={
          <>
            <span className="px-1.5 text-[11px] font-medium text-muted-foreground">
              From projects
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
                    {skill.path}
                  </span>
                </div>
              ))
            )}
            <span className="mt-1 px-1.5 text-[11px] font-medium text-muted-foreground">
              Its own
            </span>
            <div className="flex flex-wrap gap-1 px-1.5">
              {personal.map((skill) => (
                <Toggle
                  key={skill.id}
                  variant="outline"
                  size="xs"
                  className="px-2 text-xs"
                  pressed={access.personalSkills.includes(skill.id)}
                  disabled={readOnly}
                  title={skill.description}
                  onPressedChange={(on) =>
                    set({
                      personalSkills: on
                        ? [...access.personalSkills, skill.id]
                        : access.personalSkills.filter((id) => id !== skill.id),
                    })
                  }
                >
                  {skill.name}
                </Toggle>
              ))}
            </div>
          </>
        }
      />
    </div>
  );
}
