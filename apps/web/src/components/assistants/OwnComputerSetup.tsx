/**
 * "A computer of its own" inside the assistant wizard (Misha 28.10, edit 1):
 * no detour through My Uno.
 *
 *   the plan has room → "Create its computer": an Uno Work computer of role
 *     `assistant` (4 GB, the Work floor; named `<name>-computer`) is created
 *     and connected right here — Creating… → Starting… → Connecting… — and the
 *     assistant moves onto it (`onReady`);
 *   it doesn't → "Needs an upgrade" + the console's checkout of the plan that
 *     has room (rules: ownComputer.logic.ts).
 *
 * A slow computer is never an error: it's "Still starting, we'll keep
 * trying", with retries on its own (useCreateUnoBoxFlow). A refusal from the
 * console (a plan limit after all) becomes the same upgrade card.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  CloudIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  ServerIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useMemo, useState, type JSX } from "react";

import {
  type AccountSubscription,
  type PlanCatalog,
  fetchAccountComputers,
  fetchPlanCatalog,
  fetchSubscription,
} from "../../account/accountOverview";
import {
  AccountSignInRequiredError,
  AccountUnavailableError,
  accountTransport,
} from "../../account/unoAccount";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { describeMachineError } from "../../machineErrors";
import { openInNewTab } from "../../navigation/useOpenApp";
import { UNO_BOX_CREATE_STAGES, type CreateUnoBoxResult } from "../../unoBoxCreation";
import { MachineErrorNotice } from "../machines/MachineErrorNotice";
import { MachineProgressSteps } from "../machines/MachineProgressSteps";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { useCreateUnoBoxFlow } from "../useCreateUnoBoxFlow";
import {
  OWN_COMPUTER_SIZE_LINE,
  type OwnComputerDecision,
  type OwnComputerUpgrade,
  decideOwnComputer,
  describeOwnComputerFailure,
  ownComputerName,
} from "./ownComputer.logic";

/** The console's assistant templates (`assistants.Meta.template`). */
export type OwnComputerTemplate = "personal" | "marketing" | "security" | "support" | "custom";

interface AccountRead {
  /** `undefined`: the plan couldn't be read (the console decides on Create). */
  readonly subscription: AccountSubscription | null | undefined;
  readonly catalog: PlanCatalog | null;
  readonly names: ReadonlyArray<string>;
  readonly decision: OwnComputerDecision;
}

export const OWN_COMPUTER_ACCOUNT_KEY = ["assistants", "own-computer", "account"] as const;

async function readAccount(): Promise<AccountRead> {
  if (accountTransport() === "none") {
    return {
      subscription: undefined,
      catalog: null,
      names: [],
      decision: {
        kind: "unavailable",
        message: "Computers are made in the Uno Work app or at app.uno4.work.",
      },
    };
  }
  const [subscription, catalog, computers] = await Promise.allSettled([
    fetchSubscription(),
    fetchPlanCatalog(),
    fetchAccountComputers(),
  ]);
  const signedOut = [subscription, catalog, computers].some(
    (result) => result.status === "rejected" && result.reason instanceof AccountSignInRequiredError,
  );
  if (signedOut) {
    return {
      subscription: undefined,
      catalog: null,
      names: [],
      decision: { kind: "signin", message: "Sign in with Uno to give it a computer of its own." },
    };
  }
  if (subscription.status === "rejected" && subscription.reason instanceof AccountUnavailableError) {
    return {
      subscription: undefined,
      catalog: null,
      names: [],
      decision: { kind: "unavailable", message: subscription.reason.message },
    };
  }
  const read = {
    subscription: subscription.status === "fulfilled" ? subscription.value : undefined,
    catalog: catalog.status === "fulfilled" ? catalog.value : null,
    names: computers.status === "fulfilled" ? computers.value.map((computer) => computer.name) : [],
  };
  return { ...read, decision: decideOwnComputer(read) };
}

function UpgradeCard(props: {
  readonly upgrade: OwnComputerUpgrade;
  readonly checking: boolean;
  readonly onCheckAgain: () => void;
  readonly onTryAnyway: (() => void) | null;
}) {
  const { upgrade } = props;
  return (
    <div
      className="flex flex-col gap-2.5 rounded-xl border border-border bg-muted/40 p-3.5 text-sm"
      data-testid="own-computer-upgrade"
      data-reason={upgrade.reason}
    >
      <div className="flex items-start gap-2">
        <SparklesIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{upgrade.title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{upgrade.message}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => openInNewTab(upgrade.href)}
          data-testid="own-computer-upgrade-go"
          data-href={upgrade.href}
        >
          {upgrade.cta}
          <ExternalLinkIcon />
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={props.checking}
          onClick={props.onCheckAgain}
          data-testid="own-computer-check-again"
        >
          {props.checking ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
          I've paid — check again
        </Button>
        {props.onTryAnyway ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={props.onTryAnyway}
            data-testid="own-computer-try-anyway"
          >
            Create anyway
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function OwnComputerSetup(props: {
  readonly assistantName: string;
  readonly onReady: (target: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }) => void;
  readonly onCancel?: () => void;
  /** Shown on the computer's card in My Uno; defaults to none. */
  readonly emoji?: string;
  readonly template?: OwnComputerTemplate;
}): JSX.Element {
  const { assistantName, onReady, onCancel } = props;
  const navigate = useNavigate();
  const accountEnvironmentId = usePrimaryEnvironmentId();
  const account = useQuery({
    queryKey: OWN_COMPUTER_ACCOUNT_KEY,
    queryFn: readAccount,
    staleTime: 15_000,
    // Back from paying in the console: read the plan again.
    refetchOnWindowFocus: true,
    retry: false,
  });
  const [anyway, setAnyway] = useState(false);
  const [ready, setReady] = useState<{ environmentId: EnvironmentId; label: string } | null>(
    null,
  );
  const handleCreated = useCallback(
    ({ record }: CreateUnoBoxResult) => {
      const target = { environmentId: record.environmentId, label: record.label };
      setReady(target);
      onReady(target);
    },
    [onReady],
  );
  const flow = useCreateUnoBoxFlow(accountEnvironmentId, handleCreated);
  const name = useMemo(
    () => ownComputerName(assistantName, account.data?.names ?? []),
    [account.data?.names, assistantName],
  );
  const who = assistantName.trim() || "it";

  const failure = useMemo(
    () =>
      flow.error
        ? describeOwnComputerFailure(flow.error, {
            subscription: account.data?.subscription,
            catalog: account.data?.catalog,
          })
        : null,
    [account.data?.catalog, account.data?.subscription, flow.error],
  );

  const create = () => {
    if (accountEnvironmentId === null) return;
    void flow.submit({
      name,
      preset: "medium",
      computerRole: "assistant",
      explicitSize: true,
      assistant: {
        name: assistantName.trim().slice(0, 60) || "Assistant",
        emoji: props.emoji ?? "",
        template: props.template ?? "custom",
      },
    });
  };
  const checkAgain = () => {
    flow.clearError();
    setAnyway(false);
    void account.refetch();
  };

  let body: JSX.Element;
  if (ready) {
    body = (
      <p className="flex items-center gap-2 text-sm" data-testid="own-computer-ready">
        <CheckIcon className="size-4 text-success" />
        {who} will live on <b className="font-medium">{ready.label}</b>.
      </p>
    );
  } else if (account.isPending) {
    body = (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" /> Checking your plan…
      </p>
    );
  } else if (flow.stage) {
    const step = flow.stage === "retrying" ? "connecting" : flow.stage;
    body = (
      <div data-testid="own-computer-progress" data-stage={step}>
        <MachineProgressSteps
          steps={UNO_BOX_CREATE_STAGES}
          current={step}
          note={flow.stage === "retrying" ? "Still starting — trying again…" : null}
        />
      </div>
    );
  } else if (flow.stillStarting) {
    body = (
      <MachineErrorNotice
        tone="warning"
        human={{
          title: "Still starting, we'll keep trying",
          message: `${flow.stillStarting.name} is created and in your computers. It's slow to answer; ${who} moves there as soon as it does.`,
          details:
            flow.stillStarting.lastError != null
              ? describeMachineError(flow.stillStarting.lastError).details
              : null,
          transient: true,
        }}
        action={
          <Button
            size="xs"
            variant="outline"
            data-testid="own-computer-retry"
            onClick={flow.retryNow}
          >
            <RefreshCwIcon className="size-3" />
            Try again now
          </Button>
        }
      />
    );
  } else if (failure?.kind === "upgrade") {
    body = (
      <UpgradeCard
        upgrade={failure}
        checking={account.isFetching}
        onCheckAgain={checkAgain}
        onTryAnyway={null}
      />
    );
  } else {
    const decision = account.data?.decision ?? { kind: "create" as const, planName: null };
    if (decision.kind === "upgrade" && !anyway) {
      body = (
        <UpgradeCard
          upgrade={decision}
          checking={account.isFetching}
          onCheckAgain={checkAgain}
          onTryAnyway={decision.canTryAnyway ? () => setAnyway(true) : null}
        />
      );
    } else if (decision.kind === "signin" || decision.kind === "unavailable") {
      body = (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          data-testid={`own-computer-${decision.kind}`}
        >
          <span className="min-w-0 flex-1">{decision.message}</span>
          {decision.kind === "signin" ? (
            <Button size="xs" variant="outline" onClick={() => void navigate({ to: "/my-uno" })}>
              Open My Uno
            </Button>
          ) : null}
        </div>
      );
    } else {
      const planName = decision.kind === "create" ? decision.planName : null;
      body = (
        <div className="flex flex-col gap-2.5" data-testid="own-computer-offer">
          <div className="flex items-start gap-2.5">
            <CloudIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 text-sm">
              <p>
                <b className="font-medium">{name}</b>
                <span className="text-muted-foreground"> · {OWN_COMPUTER_SIZE_LINE}</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {planName ? `Fits your ${planName} plan. ` : ""}
                Only {who} works there: a bad email or page can't reach your other computers.
              </p>
            </div>
          </div>
          {failure ? (
            <MachineErrorNotice
              human={{
                title: failure.title,
                message: failure.message,
                details: failure.details,
                transient: false,
              }}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={accountEnvironmentId === null || flow.isPending}
              onClick={create}
              data-testid="own-computer-create"
            >
              <ServerIcon />
              {failure ? "Try again" : "Create its computer"}
            </Button>
            {onCancel ? (
              <Button size="sm" variant="ghost" onClick={onCancel}>
                Not now
              </Button>
            ) : null}
          </div>
        </div>
      );
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="own-computer">
      {body}
    </div>
  );
}
