/**
 * "Computers" on My Uno: every computer on the account — what it is for (its
 * role), whether it is on or asleep, how big it is, what runs on it and what
 * it costs out of the plan — with Open, Wake / Sleep, Manage and Change role.
 * The computer this desktop app runs on comes first when there is one.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIcon,
  BriefcaseIcon,
  ChevronDownIcon,
  FlaskConicalIcon,
  LaptopIcon,
  Loader2Icon,
  MoonIcon,
  PlusIcon,
  RocketIcon,
  ServerIcon,
  SunIcon,
  TestTubeDiagonalIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  type AccountComputer,
  type AccountSubscription,
  setComputerRole,
} from "../../account/accountOverview";
import { computerMonthlyShare, computerSize, formatUsd } from "../../account/billingModel";
import {
  ASSIGNABLE_ROLES,
  ROLE_BLURB,
  ROLE_LABEL,
  type ComputerRole,
} from "../../account/computerRoles";
import { accountRequest } from "../../account/unoAccount";
import { cn } from "../../lib/utils";
import { POWER_STATE_LABEL, computerPowerState } from "../computer/computerFormat";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { computerAppsQuery, refreshMyUno } from "./myUnoQueries";
import { useOpenAccountComputer } from "./useOpenAccountComputer";

export const ROLE_ICON: Record<ComputerRole, ReactNode> = {
  workspace: <BriefcaseIcon />,
  server: <ServerIcon />,
  production: <RocketIcon />,
  staging: <TestTubeDiagonalIcon />,
  sandbox: <FlaskConicalIcon />,
};

export const ROLE_TINT: Record<ComputerRole, string> = {
  workspace: "bg-primary/10 text-primary",
  server: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  production: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  staging: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  sandbox: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

const DOT = {
  on: "bg-success",
  asleep: "bg-info",
  off: "bg-muted-foreground/50",
  busy: "animate-pulse bg-warning",
  unknown: "bg-muted-foreground/40",
} as const;

export function RoleBadge({ role }: { role: ComputerRole }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium [&_svg]:size-3",
        ROLE_TINT[role],
      )}
    >
      {ROLE_ICON[role]}
      {ROLE_LABEL[role]}
    </span>
  );
}

function PowerState({ status }: { status: string }) {
  const state = computerPowerState(status);
  if (status === "error") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-destructive-foreground">
        <span className="size-2 rounded-full bg-destructive" aria-hidden />
        Needs attention
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-2 rounded-full", DOT[state])} aria-hidden />
      {POWER_STATE_LABEL[state]}
    </span>
  );
}

/** "Memos, Open WebUI and 2 more" */
function appsLine(names: ReadonlyArray<string>): string {
  if (names.length === 0) return "";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

function ComputerCard({
  computer,
  subscription,
  opening,
  onOpen,
  onManage,
}: {
  computer: AccountComputer;
  subscription: AccountSubscription | null;
  opening: string | null;
  onOpen: () => void;
  onManage: () => void;
}) {
  const queryClient = useQueryClient();
  const state = computerPowerState(computer.status);
  const apps = useQuery(computerAppsQuery(computer.id, true));
  const share = computerMonthlyShare(computer, subscription);

  const power = useMutation({
    mutationFn: (action: "wake" | "sleep") =>
      accountRequest("POST", `/api/v1/boxes/${computer.id}/${action}`, {}),
    onSettled: () => refreshMyUno(queryClient),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: `Couldn't change ${computer.name}`,
        description: error instanceof Error ? error.message : String(error),
      }),
  });

  const role = useMutation({
    mutationFn: (next: ComputerRole) => setComputerRole(computer, next),
    onSuccess: (_data, next) => {
      toastManager.add({
        type: "success",
        title: `${computer.name} is now ${ROLE_LABEL[next]}`,
      });
    },
    onSettled: () => refreshMyUno(queryClient),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't change the role",
        description: error instanceof Error ? error.message : String(error),
      }),
  });

  const appNames = (apps.data ?? []).map((app) => app.name);
  const runs = computer.workMachine
    ? appsLine(["Uno Work", ...appNames])
    : appsLine(appNames) || "Nothing from the App Store yet";

  return (
    <li
      className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card/40 p-4"
      data-testid="my-uno-computer"
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl [&_svg]:size-4.5",
            ROLE_TINT[computer.role],
          )}
        >
          {ROLE_ICON[computer.role]}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold">{computer.name}</span>
            <RoleBadge role={computer.role} />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{ROLE_BLURB[computer.role]}</p>
        </div>
        <PowerState status={computer.status} />
      </div>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-muted-foreground">Size</dt>
          <dd className="truncate font-medium">
            {computerSize(computer.ramMb, computer.vcpu)} · {computer.diskGb} GB disk
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Costs</dt>
          <dd className="truncate font-medium">
            {share === null ? "Included in your plan" : `≈ ${formatUsd(share)}/mo of your plan`}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Runs</dt>
          <dd className="truncate font-medium" title={runs}>
            {apps.isPending && !computer.workMachine ? (
              <Skeleton className="mt-0.5 h-3.5 w-24" />
            ) : (
              runs
            )}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-1.5">
        {computer.workMachine ? (
          <Button size="sm" onClick={onOpen} disabled={opening !== null}>
            {opening ? <Loader2Icon className="animate-spin" /> : null}
            {opening ?? "Open"}
          </Button>
        ) : (
          <Button size="sm" onClick={onManage}>
            <ActivityIcon />
            Manage
          </Button>
        )}
        {state === "asleep" || state === "off" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={power.isPending}
            onClick={() => power.mutate("wake")}
          >
            {power.isPending ? <Loader2Icon className="animate-spin" /> : <SunIcon />}
            Wake up
          </Button>
        ) : state === "on" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={power.isPending}
            onClick={() => {
              // A workspace may be the very computer this window works on.
              if (
                computer.workMachine &&
                !window.confirm(
                  `Put ${computer.name} to sleep? Chats and apps on it stop until you wake it; nothing is lost.`,
                )
              ) {
                return;
              }
              power.mutate("sleep");
            }}
          >
            {power.isPending ? <Loader2Icon className="animate-spin" /> : <MoonIcon />}
            Put to sleep
          </Button>
        ) : null}
        {computer.workMachine ? (
          <Button size="sm" variant="ghost" onClick={onManage}>
            <ActivityIcon />
            Monitor
          </Button>
        ) : (
          <Menu>
            <MenuTrigger
              render={
                <Button size="sm" variant="ghost" disabled={role.isPending}>
                  {role.isPending ? <Loader2Icon className="animate-spin" /> : null}
                  Change role
                  <ChevronDownIcon />
                </Button>
              }
            />
            <MenuPopup align="start" className="min-w-[18rem]">
              <MenuGroup>
                <MenuGroupLabel>What is this computer for?</MenuGroupLabel>
                {ASSIGNABLE_ROLES.map((option) => (
                  <MenuItem
                    key={option}
                    disabled={option === computer.role}
                    onClick={() => role.mutate(option)}
                  >
                    <span className="flex items-start gap-2">
                      <span className="mt-0.5 [&_svg]:size-3.5">{ROLE_ICON[option]}</span>
                      <span className="flex flex-col">
                        <span className="font-medium">
                          {ROLE_LABEL[option]}
                          {option === computer.role ? " · current" : ""}
                        </span>
                        <span className="text-xs text-muted-foreground">{ROLE_BLURB[option]}</span>
                      </span>
                    </span>
                  </MenuItem>
                ))}
              </MenuGroup>
            </MenuPopup>
          </Menu>
        )}
      </div>
    </li>
  );
}

/** The computer this desktop app runs on: yours, free, always "on" here. */
function LocalComputerCard({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <li
      className="flex flex-col gap-3 rounded-2xl border border-border/60 bg-card/40 p-4"
      data-testid="my-uno-local-computer"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary [&_svg]:size-4.5">
          <LaptopIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold">{name}</span>
            <RoleBadge role="workspace" />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Your own computer with Uno Work. It is not part of the plan and costs nothing.
          </p>
        </div>
        <PowerState status="running" />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={onOpen}>
          Open
        </Button>
      </div>
    </li>
  );
}

export function ComputersSection({
  computers,
  loading,
  subscription,
  local,
  onAdd,
  onManage,
}: {
  computers: ReadonlyArray<AccountComputer>;
  loading: boolean;
  subscription: AccountSubscription | null;
  local: { readonly name: string; readonly onOpen: () => void } | null;
  onAdd: () => void;
  onManage: (computer: AccountComputer) => void;
}) {
  const { open, opening } = useOpenAccountComputer();
  // Workspaces first, then what serves others, then the rest.
  const order: Record<ComputerRole, number> = {
    workspace: 0,
    production: 1,
    server: 2,
    staging: 3,
    sandbox: 4,
  };
  const sorted = computers.toSorted(
    (a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name),
  );

  return (
    <section className="flex flex-col gap-3" aria-labelledby="my-uno-computers">
      <header className="flex items-center gap-2">
        <h2 id="my-uno-computers" className="text-sm font-semibold">
          Computers
        </h2>
        <span className="text-xs text-muted-foreground">{computers.length + (local ? 1 : 0)}</span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={onAdd}>
          <PlusIcon />
          Add computer
        </Button>
      </header>
      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-36 w-full rounded-2xl" />
          <Skeleton className="h-36 w-full rounded-2xl" />
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {local ? <LocalComputerCard name={local.name} onOpen={local.onOpen} /> : null}
          {sorted.map((computer) => (
            <ComputerCard
              key={computer.id}
              computer={computer}
              subscription={subscription}
              opening={opening?.id === computer.id ? opening.label : null}
              onOpen={() => void open(computer)}
              onManage={() => onManage(computer)}
            />
          ))}
          {sorted.length === 0 ? (
            <li className="rounded-2xl border border-dashed border-border/80 px-4 py-6 text-center text-sm text-muted-foreground">
              No computers in the cloud yet. Add one — a workspace with Uno Work, or a small server
              for a VPN or a bot.
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
