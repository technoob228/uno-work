/**
 * "Add computer" on My Uno: first what it is for, then how big — within the
 * plan. A workspace goes through the very same Uno Work creation flow as the
 * computer switcher (steps, still-starting retries, connect); a server,
 * production, staging or sandbox computer is a plain computer with docker for
 * apps, created in one call. Nothing here works around the plan: when the plan
 * is too small the dialog says so and points at the plans.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  type AccountComputer,
  type AccountSubscription,
  createServerComputer,
  describeCreateError,
} from "../../account/accountOverview";
import { computerSize, formatRam, planTitle } from "../../account/billingModel";
import { ALL_ROLES, ROLE_BLURB, ROLE_LABEL, type ComputerRole } from "../../account/computerRoles";
import { usePrimaryEnvironmentId } from "../../environments/primary";
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
import { ROLE_ICON, ROLE_TINT } from "./ComputersSection";
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

export function AddComputerDialog({
  open,
  onOpenChange,
  subscription,
  computers,
  onSeePlans,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscription: AccountSubscription | null;
  computers: ReadonlyArray<AccountComputer>;
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
  const workspaceFits = maxRam >= WORKSPACE_MIN_RAM_MB;

  useEffect(() => {
    if (!open) {
      setRole(null);
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pickRole = (next: ComputerRole) => {
    setRole(next);
    setName(defaultName(next, taken));
    setSize(sizes[0] ?? SERVER_SIZES[0]!);
  };

  const create = useMutation({
    mutationFn: () =>
      createServerComputer({
        name: normalizeUnoBoxName(name),
        role: role ?? "server",
        ramMb: size.ramMb,
        vcpu: size.vcpu,
        diskGb: size.diskGb,
      }),
    onSuccess: () => {
      toastManager.add({
        type: "success",
        title: `${normalizeUnoBoxName(name)} is starting`,
        description: "It shows up in My Uno and is ready in about a minute.",
      });
      refreshMyUno(queryClient);
      onOpenChange(false);
    },
  });

  const createError = create.error ? describeCreateError(create.error) : null;
  const planWord = subscription ? planTitle(limits, subscription.plan) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        {role === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Add a computer</DialogTitle>
              <DialogDescription>
                What is it for? You can change this later — except a workspace, which is where Uno
                Work runs.
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
                  <p className="font-medium">Uno Work in the cloud needs a 4 GB computer.</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {subscription
                      ? `On ${planWord} a computer goes up to ${formatRam(maxRam)}.`
                      : "There's no plan on this account yet."}{" "}
                    Plus and bigger plans include it. Until then, Uno Work on your own computer (the
                    desktop app) is free.
                  </p>
                  <div>
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
                {limits ? (
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
                onClick={() => create.mutate()}
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
