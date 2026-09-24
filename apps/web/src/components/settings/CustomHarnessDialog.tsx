/**
 * Add / Edit a custom harness (Settings → Harnesses): a program on this
 * machine that speaks ACP. Saved as a `providerInstances` entry with
 * `driver: "acp"`; secret variables go to the daemon's secret store through
 * the usual sensitive-environment path. Test connection works on the draft,
 * before anything is saved.
 *
 * @module components/settings/CustomHarnessDialog
 */
import {
  type CustomHarnessTestResult,
  type EnvironmentId,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { ChevronDownIcon, KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../environments/settings/serverSettings";
import { cn } from "../../lib/utils";
import { resolveClient } from "../harness/useHarnessSetup";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  buildHarnessInstance,
  EMPTY_HARNESS_DRAFT,
  type HarnessDraft,
  type HarnessDraftField,
  type HarnessEnvDraft,
  newHarnessInstanceId,
} from "./customHarnessForm";
import { HarnessTestResultView, HarnessTestRunning } from "./HarnessTestResult";

const FOLDER_LABELS: Record<HarnessDraft["workingDirectory"], string> = {
  project: "The chat's project folder",
  home: "The home folder",
  custom: "A fixed folder",
};

function Field({
  label,
  hint,
  error,
  children,
}: {
  readonly label: string;
  readonly hint?: React.ReactNode;
  readonly error?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {error ? (
        <span className="text-[11px] text-destructive">{error}</span>
      ) : hint ? (
        <span className="text-[11px] leading-relaxed text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <p className="text-xs font-medium text-foreground">{title}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={title} />
    </div>
  );
}

export function CustomHarnessDialog({
  open,
  onOpenChange,
  environmentId,
  editing,
  initialDraft,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  /** Instance id when editing an existing Settings harness. */
  readonly editing?: ProviderInstanceId | undefined;
  readonly initialDraft?: HarnessDraft | undefined;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const { updateSettings, canMutate } = useUpdateEnvironmentSettings(environmentId);
  const [draft, setDraft] = useState<HarnessDraft>(initialDraft ?? EMPTY_HARNESS_DRAFT);
  const [showErrors, setShowErrors] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CustomHarnessTestResult | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(initialDraft ?? EMPTY_HARNESS_DRAFT);
      setShowErrors(false);
      setTestResult(null);
    }
  }, [open, initialDraft]);

  const built = useMemo(() => buildHarnessInstance(draft), [draft]);
  const errors: Partial<Record<HarnessDraftField, string>> =
    showErrors && !built.ok ? built.errors : {};
  const update = (patch: Partial<HarnessDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const updateEnv = (index: number, patch: Partial<HarnessEnvDraft>) =>
    update({
      env: draft.env.map((variable, i) => {
        if (i !== index) return variable;
        const next = { ...variable, ...patch };
        // Typing a new value replaces a stored secret.
        return patch.value !== undefined ? { ...next, redacted: false } : next;
      }),
    });

  const runTest = async () => {
    setShowErrors(true);
    if (!built.ok) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await resolveClient(environmentId).customHarness.test({
        ...(editing ? { instanceId: editing } : {}),
        config: built.config,
        environment: built.instance.environment ?? [],
      });
      setTestResult(result);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Test connection failed to run",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setShowErrors(true);
    if (!built.ok || !settings) return;
    setSaving(true);
    const existing = new Set(Object.keys(settings.providerInstances));
    const id = editing ?? ProviderInstanceId.make(newHarnessInstanceId(draft.name, existing));
    const previous = editing ? settings.providerInstances[editing] : undefined;
    const instance: ProviderInstanceConfig = {
      ...built.instance,
      ...(previous?.accentColor ? { accentColor: previous.accentColor } : {}),
    };
    try {
      await updateSettings({
        providerInstances: { ...settings.providerInstances, [id]: instance },
      });
      toastManager.add({
        type: "success",
        title: editing ? "Harness saved" : "Harness added",
        description: `${instance.displayName} is in the model picker.`,
      });
      onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save the harness",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl overflow-hidden">
        <div className="flex max-h-[85vh] min-h-0 flex-col overflow-hidden bg-background">
          <DialogHeader className="border-b border-border/70">
            <DialogTitle>{editing ? "Edit custom harness" : "Add custom harness"}</DialogTitle>
            <DialogDescription>
              Any agent installed on this machine that speaks the Agent Client Protocol (ACP) — your
              own, Gemini CLI, opencode, Kimi Code… It gets its own chats, the Approve / Deny cards
              and the model picker, like the built-in agents.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-muted/20 px-6 py-5">
            <div className="grid grid-cols-[1fr_5.5rem] gap-3">
              <Field label="Name" error={errors.name}>
                <Input
                  className="bg-background"
                  placeholder="e.g. Gemini CLI"
                  value={draft.name}
                  onChange={(event) => update({ name: event.target.value })}
                  aria-invalid={Boolean(errors.name)}
                  data-testid="harness-name"
                />
              </Field>
              <Field label="Icon">
                <Input
                  className="bg-background text-center"
                  placeholder="✨"
                  maxLength={8}
                  value={draft.icon}
                  onChange={(event) => update({ icon: event.target.value })}
                />
              </Field>
            </div>

            <Field
              label="Command"
              error={errors.commandLine}
              hint={
                <>
                  Starts the agent in ACP mode, e.g. <code>gemini --acp</code> or{" "}
                  <code>node ~/agents/my-agent.mjs</code>. A program on PATH or an absolute path —
                  it runs without a shell, so no pipes or <code>$VARS</code>.
                </>
              }
            >
              <Input
                className="bg-background font-mono text-xs"
                placeholder="gemini --acp"
                value={draft.commandLine}
                onChange={(event) => update({ commandLine: event.target.value })}
                aria-invalid={Boolean(errors.commandLine)}
                data-testid="harness-command"
              />
            </Field>

            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Environment variables</span>
              {draft.env.map((variable, index) => (
                <div
                  key={variable.key}
                  className="grid grid-cols-[10rem_1fr_auto_auto] items-center gap-2"
                >
                  <Input
                    className="bg-background font-mono text-xs"
                    placeholder="API_KEY"
                    value={variable.name}
                    onChange={(event) => updateEnv(index, { name: event.target.value.trim() })}
                    aria-label="Variable name"
                  />
                  <Input
                    className="bg-background font-mono text-xs"
                    type={variable.secret ? "password" : "text"}
                    placeholder={variable.redacted ? "•••••• stored — type to replace" : "value"}
                    value={variable.value}
                    onChange={(event) => updateEnv(index, { value: event.target.value })}
                    aria-label={`Value of ${variable.name || "variable"}`}
                  />
                  <Button
                    type="button"
                    size="xs"
                    variant={variable.secret ? "secondary" : "ghost"}
                    className="gap-1"
                    onClick={() => updateEnv(index, { secret: !variable.secret })}
                    title="Secret values are kept in the secret store, never in settings.json"
                  >
                    <KeyRoundIcon className="size-3" />
                    {variable.secret ? "Secret" : "Plain"}
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${variable.name || "variable"}`}
                    onClick={() => update({ env: draft.env.filter((_, i) => i !== index) })}
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="gap-1"
                  onClick={() =>
                    update({
                      env: [
                        ...draft.env,
                        {
                          key: `new-${Date.now()}-${draft.env.length}`,
                          name: "",
                          value: "",
                          secret: true,
                          redacted: false,
                        },
                      ],
                    })
                  }
                >
                  <PlusIcon className="size-3" />
                  Add variable
                </Button>
              </div>
              {errors.env ? (
                <span className="text-[11px] text-destructive">{errors.env}</span>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  API keys the agent reads from its environment. Secret ones never leave this
                  machine's secret store.
                </span>
              )}
            </div>

            <Field label="Runs in" error={errors.customDirectory}>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select
                  value={draft.workingDirectory}
                  onValueChange={(value) =>
                    update({ workingDirectory: value as HarnessDraft["workingDirectory"] })
                  }
                >
                  <SelectTrigger className="w-full sm:w-60" aria-label="Working folder">
                    <SelectValue>{FOLDER_LABELS[draft.workingDirectory]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(Object.keys(FOLDER_LABELS) as Array<HarnessDraft["workingDirectory"]>).map(
                      (key) => (
                        <SelectItem key={key} value={key}>
                          {FOLDER_LABELS[key]}
                        </SelectItem>
                      ),
                    )}
                  </SelectPopup>
                </Select>
                {draft.workingDirectory === "custom" ? (
                  <Input
                    className="bg-background font-mono text-xs"
                    placeholder="~/agents/my-agent"
                    value={draft.customDirectory}
                    onChange={(event) => update({ customDirectory: event.target.value })}
                  />
                ) : null}
              </div>
            </Field>

            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                <ChevronDownIcon className="size-3.5" />
                Install, models and access
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-3 space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field
                      label="Install command"
                      error={errors.installLine}
                      hint="Runs only when you press Install."
                    >
                      <Input
                        className="bg-background font-mono text-xs"
                        placeholder="npm install -g @google/gemini-cli"
                        value={draft.installLine}
                        onChange={(event) => update({ installLine: event.target.value })}
                      />
                    </Field>
                    <Field
                      label="Detect command"
                      error={errors.detectLine}
                      hint="Exit code 0 = installed; output shown as the version."
                    >
                      <Input
                        className="bg-background font-mono text-xs"
                        placeholder="gemini --version"
                        value={draft.detectLine}
                        onChange={(event) => update({ detectLine: event.target.value })}
                      />
                    </Field>
                  </div>
                  <Field
                    label="Models"
                    hint="One per line, optionally `id = Name`. Empty: the models the agent advertises, or its default."
                  >
                    <Textarea
                      className="bg-background font-mono text-xs"
                      rows={3}
                      placeholder={"gemini-2.5-pro = Gemini 2.5 Pro\ngemini-2.5-flash"}
                      value={draft.modelsText}
                      onChange={(event) => update({ modelsText: event.target.value })}
                    />
                  </Field>
                  <Field
                    label="ACP auth method"
                    hint="Only if the agent needs an `authenticate` call; most read a key from the environment."
                  >
                    <Input
                      className="bg-background font-mono text-xs"
                      placeholder="(none)"
                      value={draft.authMethodId}
                      onChange={(event) => update({ authMethodId: event.target.value })}
                    />
                  </Field>
                  <ToggleRow
                    title="Use this account's Uno AI"
                    description="Passes UNO_GATEWAY_API_KEY and UNO_GATEWAY_BASE_URL (OpenAI-compatible) — spending is billed to the account."
                    checked={draft.shareUnoGateway}
                    onChange={(shareUnoGateway) => update({ shareUnoGateway })}
                  />
                  <ToggleRow
                    title="Let it manage Uno computers"
                    description="Passes this computer's Uno identity (UNO_AGENT_API_KEY), with the rights set in Computer access."
                    checked={draft.shareUnoAccount}
                    onChange={(shareUnoAccount) => update({ shareUnoAccount })}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible>

            {testing ? <HarnessTestRunning /> : null}
            {testResult && !testing ? <HarnessTestResultView result={testResult} /> : null}
          </div>

          <DialogFooter className="border-t bg-background sm:justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={testing || !canMutate}
              onClick={() => void runTest()}
              data-testid="harness-dialog-test"
            >
              {testing ? "Testing…" : "Test connection"}
            </Button>
            <div className={cn("flex gap-2")}>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={saving || !canMutate}
                onClick={() => void save()}
                data-testid="harness-dialog-save"
              >
                {editing ? "Save" : "Add harness"}
              </Button>
            </div>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
