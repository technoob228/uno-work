/**
 * "Import from my computer" inside the setup's page (13.11): the same flow as
 * Computers → Add computer → Your own computer — connect the laptop (or pick
 * one already connected), "What is it for?", "Bring your work?" — built from
 * the same parts (`ownComputerParts.tsx`), with the state kept here instead of
 * the window's store. The step around it owns the Bring button
 * (`flow.choice.bring()`) and what happens after it.
 */
import type { MyComputer } from "@t3tools/contracts";
import { LaptopIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { useComputersHostId } from "../../computersLifecycle/useComputers";
import { useMyComputers } from "../../localComputer/useMyComputers";
import {
  BringChoiceList,
  ConnectOwnComputer,
  LifecycleCard,
  PurposeCards,
  useBringChoice,
  useComputerName,
  useLocalPairFlow,
  usePurposeChoice,
  type BringChoice,
  type PairFlow,
  type PurposeChoice,
} from "../computersLifecycle/ownComputerParts";
import { computerStatusLine } from "../localComputer/connectComputer.logic";
import { SetupHeading } from "./SetupShell";

export type ImportPhase = "loading" | "pick" | "connect" | "purpose" | "bring";

export interface ImportFlow {
  readonly phase: ImportPhase;
  /** The person's computer the projects come from. */
  readonly computerId: string | null;
  readonly computerName: string;
  /** Computers already connected to this account. */
  readonly computers: ReadonlyArray<MyComputer>;
  readonly pair: PairFlow;
  readonly purpose: PurposeChoice;
  readonly choice: BringChoice;
  readonly pickComputer: (computerId: string) => void;
  readonly connectAnother: () => void;
  readonly backToComputers: () => void;
}

export function useImportFromComputer(): ImportFlow {
  const hostId = useComputersHostId();
  const { computers, settled } = useMyComputers(hostId);
  const [phase, setPhase] = useState<Exclude<ImportPhase, "loading"> | null>(null);
  const [computerId, setComputerId] = useState<string | null>(null);
  const connected = useCallback((id: string) => {
    setComputerId(id);
    setPhase("purpose");
  }, []);
  const pair = useLocalPairFlow(connected);
  const purpose = usePurposeChoice({
    computerId,
    preselect: null,
    onChosen: () => setPhase("bring"),
  });
  const choice = useBringChoice(computerId);
  const computerName = useComputerName(computerId);

  // A computer connected before: pick it; none yet: connect one.
  useEffect(() => {
    if (phase !== null || !settled) return;
    setPhase(computers.length > 0 ? "pick" : "connect");
  }, [computers.length, phase, settled]);

  return {
    phase: phase ?? "loading",
    computerId,
    computerName,
    computers,
    pair,
    purpose,
    choice,
    // Already connected: what it is for was asked then.
    pickComputer: (id) => {
      setComputerId(id);
      setPhase("bring");
    },
    connectAnother: () => {
      setComputerId(null);
      setPhase("connect");
    },
    backToComputers: () => {
      setComputerId(null);
      setPhase("pick");
    },
  };
}

function Heading({ page, title, lead }: { page: boolean; title: string; lead: ReactNode }) {
  if (page) return <SetupHeading title={title} lead={lead} />;
  return (
    <div className="mb-4">
      <h3 className="text-base font-medium">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{lead}</p>
    </div>
  );
}

/** The current part of the import, with its heading. */
export function ImportFromComputer({
  flow,
  page = true,
}: {
  flow: ImportFlow;
  /** The step's own heading (the developer way), or a section of another step (Project). */
  page?: boolean;
}) {
  const body = "max-w-xl";
  switch (flow.phase) {
    case "loading":
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          Looking for your computers…
        </p>
      );
    case "pick":
      return (
        <div data-testid="setup-import-pick">
          <Heading
            page={page}
            title="Where are your projects?"
            lead="Pick the computer you code on. Uno copies the projects you choose to this one."
          />
          <div className={`flex flex-col gap-2 ${body}`}>
            {flow.computers.map((computer) => (
              <LifecycleCard
                key={computer.id}
                icon={<LaptopIcon />}
                title={computer.name || "Your computer"}
                detail={computerStatusLine(computer, Date.now())}
                testId={`setup-import-computer-${computer.id}`}
                disabled={!computer.online}
                onClick={() => flow.pickComputer(computer.id)}
              />
            ))}
            <LifecycleCard
              icon={<PlusIcon />}
              title="Connect another computer"
              detail="Mac, Windows or Linux."
              testId="setup-import-connect-another"
              onClick={flow.connectAnother}
            />
          </div>
        </div>
      );
    case "connect":
      return (
        <div data-testid="setup-import-connect">
          <Heading
            page={page}
            title="Connect your laptop"
            lead="Install Uno Work on the computer you code on. It takes a minute, then you pick the projects."
          />
          <div className={body}>
            <ConnectOwnComputer flow={flow.pair} />
            {flow.computers.length > 0 ? (
              <button
                type="button"
                className="mt-4 text-xs text-muted-foreground hover:text-foreground hover:underline"
                onClick={flow.backToComputers}
              >
                Use a connected computer instead
              </button>
            ) : null}
          </div>
        </div>
      );
    case "purpose":
      return (
        <div data-testid="setup-import-purpose">
          <Heading page={page} title={`${flow.computerName} is connected`} lead="What is it for?" />
          <div className={body}>
            <PurposeCards choice={flow.purpose} />
          </div>
        </div>
      );
    case "bring":
      return (
        <div data-testid="setup-import-bring">
          <Heading
            page={page}
            title="Pick what to bring"
            lead={`Code comes with its git history. .env files stay on ${flow.computerName}: tick the keys you need, Uno keeps them encrypted.`}
          />
          <div className={body}>
            <BringChoiceList choice={flow.choice} />
          </div>
        </div>
      );
  }
}
