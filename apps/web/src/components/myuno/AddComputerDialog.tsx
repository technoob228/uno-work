/**
 * "Add computer" on My Uno: first what it is for, then how big — within the
 * plan. A workspace goes through the very same Uno Work creation flow as the
 * computer switcher (steps, still-starting retries, connect); a server,
 * production, staging or sandbox computer is a plain computer with docker for
 * apps, created in one call. Nothing here works around the plan: when the plan
 * is too small the dialog says so and points at the plans.
 *
 * Plans "always on": when the new computer doesn't fit in the always-on
 * memory and the console offers it (`409 PEAK_EXCEEDED` with
 * `run_on_boosts`), the dialog asks how to run it — on boosts, by putting a
 * running computer to sleep, or on the next plan. An older console answers
 * without `run_on_boosts`: the plain error, as before.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, ExternalLinkIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  type AccountComputer,
  type AccountSubscription,
  type PlanCatalog,
  consoleLinks,
  createServerComputer,
  describeCreateError,
} from "../../account/accountOverview";
import {
  type RunPastPlanChoices,
  SLEEPING_DONT_COUNT,
  alwaysOnTitle,
  nextAlwaysOnPlan,
  parsePeakExceeded,
  runPastPlanChoices,
  runningNowLine,
  showsAlwaysOn,
} from "../../account/alwaysOn";
import { accountRequest } from "../../account/unoAccount";
import { openInNewTab } from "../../navigation/useOpenApp";
import { computerSize, formatRam, planTitle } from "../../account/billingModel";
import { ALL_ROLES, ROLE_BLURB, ROLE_LABEL, type ComputerRole } from "../../account/computerRoles";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { isWebLite, liteLinks, openCloudWork } from "../../lite/webLite";
import { useSwitchEnvironment } from "../../hooks/useSwitchEnvironment";
import { cn } from "../../lib/utils";
import { normalizeUnoBoxName } from "../../unoBoxCreation";
import { CreateUnoBoxSection } from "../CreateUnoBoxSection";
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
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { ROLE_ICON, ROLE_TINT } from "./roleUi";
import { refreshMyUno } from "./myUnoQueries";

interface ServerSize {
  readonly ramMb: number;
  readonly vcpu: number;
  readonly diskGb: number;
}

const SERVER_SIZES: ReadonlyArray<ServerSize> = [
  { ramMb: 1024, vcpu: 1, diskGb: 10 },
  { ramMb: 2048, vcpu: 1, diskGb: 20 },
  { ramMb: 4096, vcpu: 2, diskGb: 30 },
  { ramMb: 8192, vcpu: 4, diskGb: 60 },
];

const WORKSPACE_MIN_RAM_MB = 4096;

function defaultName(role: ComputerRole, taken: ReadonlySet<string>): string {
  const base = role === "workspace" ? "workspace" : role;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  return base;
}

type PastPlanPick = "boosts" | "sleep" | "plan";

/** After the sleep call the console frees the memory within seconds: ask again a few times. */
const SLEEP_RETRY_MS = 3_000;
const SLEEP_RETRIES = 5;

function firstPick(choices: RunPastPlanChoices): PastPlanPick {
  if (choices.boosts.possible) return "boosts";
  if (choices.sleep) return "sleep";
  return "plan";
}

/** "Start “scraper” — 4 GB?" and the three ways to run it. */
function RunPastPlanPanel({
  choices,
  pick,
  onPick,
}: {
  choices: RunPastPlanChoices;
  pick: PastPlanPick;
  onPick: (pick: PastPlanPick) => void;
}) {
  const options: Array<{ key: PastPlanPick; title: string; detail: string | null; on: boolean }> = [
    {
      key: "boosts",
      title: choices.boosts.title,
      detail: choices.boosts.detail,
      on: choices.boosts.possible,
    },
    ...(choices.sleep
      ? [
          {
            key: "sleep" as const,
            title: choices.sleep.title,
            detail: `${choices.sleep.computer.name} wakes in about a second when you open it.`,
            on: true,
          },
        ]
      : []),
    ...(choices.nextPlan
      ? [{ key: "plan" as const, title: choices.nextPlan.title, detail: null, on: true }]
      : []),
  ];
  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="How to run it">
      {options.map((option) => {
        const active = option.on && pick === option.key;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={!option.on}
            onClick={() => onPick(option.key)}
            className={cn(
              "flex flex-col gap-0.5 rounded-xl border px-3.5 py-3 text-left text-sm transition-colors",
              active
                ? "border-primary bg-primary/5"
                : "border-border/60 hover:bg-accent/40 disabled:opacity-60 disabled:hover:bg-transparent",
            )}
            data-testid={`run-past-plan-${option.key}`}
          >
            <span className="font-medium">{option.title}</span>
            {option.detail ? (
              <span className="text-xs text-muted-foreground">{option.detail}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function AddComputerDialog({
  open,
  onOpenChange,
  subscription,
  computers,
  catalog,
  onSeePlans,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription: AccountSubscription | null;
  computers: ReadonlyArray<AccountComputer>;
  /** For "Get Pro — always on 16 GB, $70/mo" when the new computer doesn't fit. */
  catalog?: PlanCatalog | undefined;
  onSeePlans: () => void;
}) {
  const queryClient = useQueryClient();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const switchEnvironment = useSwitchEnvironment();
  const [role, setRole] = useState<ComputerRole | null>(null);
  const [name, setName] = useState("");
  const [size, setSize] = useState<ServerSize>(SERVER_SIZES[0]!);

  const taken = useMemo(() => new Set(computers.map((c) => c.name)), [computers]);
  const limits = subscription?.limits ?? null;
  const maxRam = limits?.maxBoxRamMb ?? 0;
  const sizes = SERVER_SIZES.filter((s) => maxRam === 0 || s.ramMb <= maxRam);
  // Web lite asks the plan itself (the console's cloud_work: Plus and up).
  const workspaceFits = isWebLite ? limits?.cloudWork === true : maxRam >= WORKSPACE_MIN_RAM_MB;

  useEffect(() => {
    if (!open) {
      setRole(null);
      setPick(null);
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pickRole = (next: ComputerRole) => {
    setRole(next);
    setName(defaultName(next, taken));
    setSize(sizes[0] ?? SERVER_SIZES[0]!);
  };

  const createOnce = (runOnBoosts: boolean) =>
    createServerComputer({
      name: normalizeUnoBoxName(name),
      role: role ?? "server",
      ramMb: size.ramMb,
      vcpu: size.vcpu,
      diskGb: size.diskGb,
      ...(runOnBoosts ? { runOnBoosts: true } : {}),
    });

  const create = useMutation({
    mutationFn: async (how: { runOnBoosts?: boolean; sleepFirst?: AccountComputer } = {}) => {
      if (!how.sleepFirst) return createOnce(how.runOnBoosts === true);
      await accountRequest("POST", `/api/v1/boxes/${how.sleepFirst.id}/sleep`, {});
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await createOnce(false);
        } catch (error) {
          if (attempt >= SLEEP_RETRIES || !parsePeakExceeded(error)) throw error;
          await new Promise((resolve) => setTimeout(resolve, SLEEP_RETRY_MS));
        }
      }
    },
    onSuccess: (_box, how) => {
      toastManager.add({
        type: "success",
        title: `${normalizeUnoBoxName(name)} is starting`,
        description: how?.runOnBoosts
          ? "It runs on boosts. When they run out, it goes to sleep — your main computer stays on."
          : "It shows up in My Uno and is ready in about a minute.",
      });
      refreshMyUno(queryClient);
      onOpenChange(false);
    },
  });

  // Doesn't fit in the always-on memory, and the console offers ways out.
  const peak = create.error ? parsePeakExceeded(create.error) : null;
  const choices: RunPastPlanChoices | null =
    peak?.runOnBoosts && role && role !== "workspace"
      ? runPastPlanChoices({
          name: normalizeUnoBoxName(name),
          ramMb: size.ramMb,
          peak,
          computers,
          nextPlan: nextAlwaysOnPlan(catalog, subscription),
        })
      : null;
  const [pickState, setPick] = useState<PastPlanPick | null>(null);
  const pick: PastPlanPick | null = choices
    ? pickState &&
      (pickState === "boosts"
        ? choices.boosts.possible
        : pickState === "sleep"
          ? choices.sleep !== null
          : choices.nextPlan !== null)
      ? pickState
      : firstPick(choices)
    : null;
  const runPick = () => {
    if (!choices || !pick) return;
    if (pick === "boosts") create.mutate({ runOnBoosts: true });
    else if (pick === "sleep" && choices.sleep)
      create.mutate({ sleepFirst: choices.sleep.computer });
    else if (choices.nextPlan) openInNewTab(consoleLinks.plan(choices.nextPlan.plan.slug));
    else {
      onOpenChange(false);
      onSeePlans();
    }
  };

  const createError = create.error && !choices ? describeCreateError(create.error) : null;
  const planWord = subscription ? planTitle(limits, subscription.plan) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        {role === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Add a computer</DialogTitle>
              <DialogDescription>
                What is it for? A server's role can be changed later; an Uno Work computer stays
                one.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {ALL_ROLES.map((option) => (
                  <li key={option}>
                    <button
                      type="button"
                      onClick={() => pickRole(option)}
                      className="flex h-full w-full items-start gap-3 rounded-xl border border-border/60 bg-card/40 p-3 text-left transition-colors hover:bg-accent/50"
                      data-testid={`add-computer-role-${option}`}
                    >
                      <span
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4",
                          ROLE_TINT[option],
                        )}
                      >
                        {ROLE_ICON[option]}
                      </span>
                      <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium">{ROLE_LABEL[option]}</span>
                        <span className="text-xs text-muted-foreground">{ROLE_BLURB[option]}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </DialogPanel>
          </>
        ) : role === "workspace" ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Back"
                  onClick={() => setRole(null)}
                >
                  <ArrowLeftIcon />
                </Button>
                A new workspace
              </DialogTitle>
              <DialogDescription>
                A computer in the cloud with Uno Work: chats, agents, files and apps — always a
                click away, from any device.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              {!subscription || !workspaceFits ? (
                <div className="flex flex-col gap-3 rounded-xl bg-muted/40 p-4 text-sm">
                  <p className="font-medium">
                    {isWebLite
                      ? "Uno Work in the cloud starts at Plus."
                      : "Uno Work in the cloud needs a 4 GB computer."}
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {subscription
                      ? `On ${planWord} a computer goes up to ${formatRam(maxRam)}.`
                      : "There's no plan on this account yet."}{" "}
                    Plus and bigger plans include it. Until then, Uno Work on your own computer (the
                    desktop app) is free.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        onOpenChange(false);
                        onSeePlans();
                      }}
                    >
                      <SparklesIcon />
                      See plans
                    </Button>
                    {isWebLite ? (
                      <Button
                        size="sm"
                        variant="outline"
                        render={<a href={liteLinks.download} target="_blank" rel="noreferrer" />}
                      >
                        Download the app
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : isWebLite ? (
                <div className="flex flex-col gap-3 rounded-xl bg-muted/40 p-4 text-sm">
                  <p className="font-medium">{planWord} includes Uno Work in the cloud.</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Open it and Uno sets up your workspace. Just upgraded? Give it up to 30 seconds
                    to catch up.
                  </p>
                  <div>
                    <Button size="sm" onClick={openCloudWork}>
                      <SparklesIcon />
                      Open Uno Work in the cloud
                    </Button>
                  </div>
                </div>
              ) : (
                <CreateUnoBoxSection
                  environmentId={primaryEnvironmentId}
                  defaultName={defaultName("workspace", taken)}
                  submitLabel="Create workspace"
                  onCreated={({ record }) => {
                    onOpenChange(false);
                    refreshMyUno(queryClient);
                    toastManager.add({
                      type: "success",
                      title: "Workspace ready",
                      description: `${record.label} is connected.`,
                    });
                    switchEnvironment(record.environmentId, { landing: "computer" });
                  }}
                />
              )}
            </DialogPanel>
          </>
        ) : choices && pick ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Back"
                  onClick={() => create.reset()}
                >
                  <ArrowLeftIcon />
                </Button>
                {choices.title}
              </DialogTitle>
              <DialogDescription>{choices.lead}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <RunPastPlanPanel choices={choices} pick={pick} onPick={setPick} />
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={create.isPending} onClick={runPick} data-testid="run-past-plan-go">
                {create.isPending ? <Spinner className="size-3.5" /> : null}
                {pick === "boosts"
                  ? "Start on boosts"
                  : pick === "sleep" && choices.sleep
                    ? `Sleep ${choices.sleep.computer.name} and start`
                    : choices.nextPlan
                      ? `Get ${choices.nextPlan.plan.name}`
                      : "See plans"}
                {pick === "plan" && choices.nextPlan ? <ExternalLinkIcon /> : null}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Back"
                  onClick={() => setRole(null)}
                >
                  <ArrowLeftIcon />
                </Button>
                A new {ROLE_LABEL[role].toLowerCase()} computer
              </DialogTitle>
              <DialogDescription>{ROLE_BLURB[role]}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="my-uno-new-name">Name</Label>
                <Input
                  id="my-uno-new-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="vpn"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Size</span>
                {sizes.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    There's no plan on this account yet, so there's no room for a computer.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Size">
                    {sizes.map((option) => {
                      const active = option.ramMb === size.ramMb;
                      return (
                        <button
                          key={option.ramMb}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => setSize(option)}
                          className={cn(
                            "rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                            active
                              ? "border-primary bg-primary/8 text-foreground"
                              : "border-border/60 text-muted-foreground hover:bg-accent/40",
                          )}
                        >
                          <span className="block font-medium text-foreground">
                            {computerSize(option.ramMb, option.vcpu)}
                          </span>
                          {option.diskGb} GB disk
                        </button>
                      );
                    })}
                  </div>
                )}
                {showsAlwaysOn(subscription) ? (
                  <p className="text-[11px] text-muted-foreground">
                    {alwaysOnTitle(subscription.alwaysOn.ramMb)} ·{" "}
                    {runningNowLine(subscription.alwaysOn).replace(/^Running now/, "running now")}.{" "}
                    {SLEEPING_DONT_COUNT} It comes with docker, so apps like a VPN or a bot install
                    in a click.
                  </p>
                ) : limits ? (
                  <p className="text-[11px] text-muted-foreground">
                    {planWord} runs {formatRam(limits.peakRamMb)} at once; right now{" "}
                    {formatRam(subscription?.usage.runningRamMb ?? 0)} is running. Sleeping
                    computers don't count. It comes with docker, so apps like a VPN or a bot install
                    in a click.
                  </p>
                ) : null}
              </div>
              {createError ? (
                <div className="flex flex-col gap-2 rounded-xl bg-destructive/8 px-3 py-2.5 text-xs">
                  <p className="text-destructive-foreground">{createError.message}</p>
                  {createError.plan ? (
                    <div>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          onOpenChange(false);
                          onSeePlans();
                        }}
                      >
                        See plans
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={
                  create.isPending || sizes.length === 0 || normalizeUnoBoxName(name).length === 0
                }
                onClick={() => create.mutate({})}
              >
                {create.isPending ? <Spinner className="size-3.5" /> : null}
                Create {ROLE_LABEL[role].toLowerCase()}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
