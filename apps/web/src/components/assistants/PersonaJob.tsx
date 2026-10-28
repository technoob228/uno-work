/**
 * "What should it do?" (Misha 28.10) — what the role picked in the gallery needs:
 *
 * - Developer: the projects it leads on its computer, repos to clone first
 *   (its chat clones them), the first thing to lead.
 * - Accounts manager: which accounts — the logins go through a form in a window
 *   (never the chat) straight into the password vault of its computer. Signing in happens in a chat it starts
 *   there with `browser_command {login}`: the password is typed into the page
 *   by the computer, the model never sees it; 2FA and captchas come to you.
 * - Helper: Gmail, Drive, Notion… connected on its computer (the same cards as
 *   Settings → Connectors) or an MCP server of your own; which of them it uses.
 *
 * Then when it starts: only when you ask (default) or now, with a task.
 * Regular tasks are a separate feature (Automations) — not here.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { KeyRoundIcon, LoaderCircleIcon, LockIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../environments/settings/serverSettings";
import { cn, randomUUID } from "../../lib/utils";
import { connectorSignedIn } from "../setup/connectorSignIn.logic";
import { ConnectorsList, PROVIDERS, useConnectors } from "../setup/steps/ConnectorsStep";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  type AccountDraft,
  type AccountProblems,
  EMPTY_ACCOUNT,
  HANDS_WORK_LINE,
  type JobDraft,
  type JobStart,
  START_COPY,
  accountProblems,
  filledAccounts,
  hasProblems,
  jobAccountOf,
} from "./assistantJob.logic";
import { saveLoginsToVault } from "./assistantStart";
import { Chip, Label, ModeCard, usePersonaProjects } from "./PersonaParts";

/** Connected apps on that computer and its own MCP servers (for the first message). */
export function useJobTools(environmentId: string | null) {
  const connectors = useConnectors(environmentId as EnvironmentId | null);
  const settings = useEnvironmentSettings(environmentId as EnvironmentId | null);
  const apps = (connectors.data?.connectors ?? [])
    .filter((connector) => connectorSignedIn(connector))
    .map((connector) => ({
      provider: connector.provider as string,
      name: PROVIDERS.find((meta) => meta.provider === connector.provider)?.name ?? connector.name,
    }));
  const servers = (settings?.mcpServers ?? [])
    .filter((server) => server.enabled !== false)
    .map((server) => server.name);
  return { apps, servers };
}

// ── Accounts: the form in a window ───────────────────────────────────────

type AccountRow = AccountDraft & { readonly key: string };
const newRow = (): AccountRow => ({ ...EMPTY_ACCOUNT, key: randomUUID() });

function AccountsDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly computer: string;
  readonly onClose: () => void;
  readonly onSaved: (rows: ReadonlyArray<AccountDraft>) => void;
}) {
  // The passwords live here only while the window is open.
  const [rows, setRows] = useState<ReadonlyArray<AccountRow>>(() => [newRow()]);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filled = filledAccounts(rows);
  const problems: ReadonlyArray<AccountProblems> = rows.map((row) =>
    filled.includes(row) ? accountProblems(row) : {},
  );
  const blocked = filled.length === 0 || problems.some(hasProblems);

  const patch = (index: number, next: Partial<AccountDraft>) =>
    setRows(rows.map((row, at) => (at === index ? { ...row, ...next } : row)));

  const save = async () => {
    setTried(true);
    if (blocked) {
      if (filled.length === 0) setError("Fill in one account.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveLoginsToVault(props.environmentId, filled);
      props.onSaved(filled);
      setRows([newRow()]);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? `Couldn't save: ${cause.message}`
          : `Couldn't save — ${props.computer} didn't answer.`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open || saving ? undefined : props.onClose())}>
      <DialogPopup className="max-w-xl" data-testid="persona-accounts-dialog">
        <DialogHeader>
          <DialogTitle>Accounts it works in</DialogTitle>
          <DialogDescription>
            Saved in the passwords on {props.computer} — not in a chat. When it signs in, the
            computer types the password into the page; the AI never sees it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto px-6 pb-2">
          {rows.map((row, index) => {
            const problem = tried ? problems[index] : undefined;
            return (
              <div
                key={row.key}
                className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-2"
                data-testid="persona-account-row"
              >
                <Field label="Account" problem={problem?.service}>
                  <Input
                    value={row.service}
                    maxLength={40}
                    placeholder="Instagram"
                    onChange={(event) => patch(index, { service: event.target.value })}
                    data-testid="persona-account-service"
                  />
                </Field>
                <Field label="Site" problem={problem?.site}>
                  <Input
                    value={row.site}
                    maxLength={200}
                    placeholder="instagram.com"
                    spellCheck={false}
                    onChange={(event) => patch(index, { site: event.target.value })}
                    data-testid="persona-account-site"
                  />
                </Field>
                <Field label="Login" problem={problem?.username}>
                  <Input
                    value={row.username}
                    maxLength={200}
                    placeholder="you@example.com"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => patch(index, { username: event.target.value })}
                    data-testid="persona-account-username"
                  />
                </Field>
                <Field label="Password" problem={problem?.password}>
                  <Input
                    type="password"
                    value={row.password}
                    autoComplete="new-password"
                    onChange={(event) => patch(index, { password: event.target.value })}
                    data-testid="persona-account-password"
                  />
                </Field>
                {rows.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setRows(rows.filter((_, at) => at !== index))}
                    className="inline-flex w-fit cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <Trash2Icon className="size-3" /> Remove
                  </button>
                ) : null}
              </div>
            );
          })}
          <Button
            size="xs"
            variant="ghost"
            className="self-start"
            onClick={() => setRows([...rows, newRow()])}
            data-testid="persona-account-more"
          >
            <PlusIcon className="size-3.5" /> Another account
          </Button>
          {error ? (
            <p
              className="text-xs text-destructive"
              role="alert"
              data-testid="persona-accounts-error"
            >
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving} data-testid="persona-accounts-save">
            {saving ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <LockIcon className="size-3.5" />
            )}
            Save on {props.computer}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Field(props: {
  readonly label: string;
  readonly problem: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
      {props.children}
      {props.problem ? (
        <span className="text-xs text-destructive" data-testid="persona-account-problem">
          {props.problem}
        </span>
      ) : null}
    </label>
  );
}

function StartPicker(props: {
  readonly value: JobStart;
  readonly onChange: (start: JobStart) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="persona-start">
      {(["ask", "now"] as const).map((start) => (
        <ModeCard
          key={start}
          on={props.value === start}
          onClick={() => props.onChange(start)}
          title={START_COPY[start].label}
          line={START_COPY[start].line}
          testId={`persona-start-${start}`}
        />
      ))}
    </div>
  );
}

// ── The step ─────────────────────────────────────────────────────────────

export function PersonaJob(props: {
  readonly name: string;
  readonly environmentId: string;
  readonly computer: string;
  /** Projects it may see on its computer (keys `env:id`), or every one. */
  readonly projects: "all" | ReadonlySet<string>;
  readonly draft: JobDraft;
  readonly onChange: (draft: JobDraft) => void;
  readonly problem: string | null;
}) {
  const { draft, onChange } = props;
  const set = (next: Partial<JobDraft>) => onChange({ ...draft, ...next });
  const [accountsOpen, setAccountsOpen] = useState(false);
  const allProjects = usePersonaProjects(props.environmentId);
  const projects = allProjects.filter(
    (project) =>
      project.environmentId === props.environmentId &&
      (props.projects === "all" || props.projects.has(project.key)),
  );
  const tools = useJobTools(props.environmentId);
  const who = props.name.trim() || "it";

  return (
    <div className="flex flex-col gap-4" data-testid="persona-job">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">What should {who} do?</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{HANDS_WORK_LINE}</p>
      </div>
      {draft.kind === "development" ? (
        <div className="flex flex-col gap-4" data-testid="persona-job-development-form">
          <div>
            <Label hint={`on ${props.computer}`}>Projects it leads</Label>
            {projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No projects on {props.computer} yet — add a repo below.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {projects.map((project) => (
                  <Chip
                    key={project.key}
                    on={draft.devProjects.includes(project.title)}
                    onClick={() =>
                      set({
                        devProjects: draft.devProjects.includes(project.title)
                          ? draft.devProjects.filter((title) => title !== project.title)
                          : [...draft.devProjects, project.title],
                      })
                    }
                    testId={`persona-dev-project-${project.projectId}`}
                  >
                    {project.title}
                  </Chip>
                ))}
              </div>
            )}
          </div>
          <div>
            <Label hint="its chat clones them first">Add a repo</Label>
            <Input
              value={draft.repos}
              placeholder="owner/name or https://github.com/owner/name"
              spellCheck={false}
              onChange={(event) => set({ repos: event.target.value })}
              data-testid="persona-dev-repos"
            />
          </div>
        </div>
      ) : null}

      {draft.kind === "accounts" ? (
        <div className="flex flex-col gap-4" data-testid="persona-job-accounts-form">
          <div>
            <Label hint={`passwords stay on ${props.computer}`}>Accounts</Label>
            <div className="flex flex-col gap-1.5">
              {draft.accounts.map((account) => (
                <div
                  key={`${account.site}:${account.username}`}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                  data-testid="persona-account-saved"
                >
                  <KeyRoundIcon className="size-3.5 shrink-0 text-success" />
                  <span className="min-w-0 flex-1 truncate">
                    <b className="font-medium">{account.service}</b>{" "}
                    <span className="text-muted-foreground">
                      · {account.site} · {account.username}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">password saved</span>
                  <button
                    type="button"
                    aria-label={`Remove ${account.service}`}
                    onClick={() =>
                      set({ accounts: draft.accounts.filter((item) => item !== account) })
                    }
                    className="cursor-pointer text-muted-foreground hover:text-foreground"
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                onClick={() => setAccountsOpen(true)}
                data-testid="persona-accounts-add"
              >
                <LockIcon className="size-3.5" />
                {draft.accounts.length === 0 ? "Add accounts" : "Add another"}
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              It signs in from a chat on {props.computer}. A 2FA code or a captcha — it asks you.
            </p>
          </div>
          {accountsOpen ? (
            <AccountsDialog
              environmentId={props.environmentId as EnvironmentId}
              computer={props.computer}
              onClose={() => setAccountsOpen(false)}
              onSaved={(rows) => {
                setAccountsOpen(false);
                const added = rows.map(jobAccountOf);
                const kept = draft.accounts.filter(
                  (account) =>
                    !added.some(
                      (item) => item.site === account.site && item.username === account.username,
                    ),
                );
                set({ accounts: [...kept, ...added], accountsOn: props.environmentId });
              }}
            />
          ) : null}
        </div>
      ) : null}

      {draft.kind === "tasks" ? (
        <div className="flex flex-col gap-4" data-testid="persona-job-tasks-form">
          <div>
            <Label hint={`connected on ${props.computer}`}>Apps and tools</Label>
            <ConnectorsList environmentId={props.environmentId as EnvironmentId} />
          </div>
          {tools.apps.length > 0 ? (
            <div>
              <Label>{who} may use</Label>
              <div className="flex flex-wrap gap-1.5">
                {tools.apps.map((app) => (
                  <Chip
                    key={app.provider}
                    on={!draft.appsOff.includes(app.provider)}
                    onClick={() =>
                      set({
                        appsOff: draft.appsOff.includes(app.provider)
                          ? draft.appsOff.filter((provider) => provider !== app.provider)
                          : [...draft.appsOff, app.provider],
                      })
                    }
                    testId={`persona-app-${app.provider}`}
                  >
                    {app.name}
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div>
        <Label>When it starts</Label>
        <StartPicker value={draft.start} onChange={(start) => set({ start })} />
      </div>
      {draft.start === "now" ? (
        <TaskField
          value={draft.task}
          onChange={(task) => set({ task })}
          {...TASK_FIELD[draft.kind]}
        />
      ) : null}
      {props.problem ? (
        <p
          className={cn("text-xs text-destructive")}
          role="alert"
          data-testid="persona-job-problem"
        >
          {props.problem}
        </p>
      ) : null}
    </div>
  );
}

const TASK_FIELD: Record<JobDraft["kind"], { label: string; placeholder: string }> = {
  development: {
    label: "What to lead first",
    placeholder: "Get the checkout tests green and open a PR",
  },
  accounts: {
    label: "What it does there",
    placeholder: "Post the weekly update and answer new comments",
  },
  tasks: { label: "First task", placeholder: "Sum up today's new mail and meetings" },
};

function TaskField(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly placeholder: string;
}) {
  return (
    <div>
      <Label hint="optional">{props.label}</Label>
      <Textarea
        value={props.value}
        maxLength={500}
        rows={2}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        data-testid="persona-job-task"
      />
    </div>
  );
}
