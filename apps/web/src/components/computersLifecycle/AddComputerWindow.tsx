/**
 * The one "Add computer" window (Misha 02.11, SPEC "Один путь"): every entry —
 * Home's "Connect your AI or other computers", the computers menu, Settings,
 * Connectors, My Uno — lands here.
 *
 *   choose → Uno cloud computer (today's flow: plan, region)
 *          → Your own computer → own: Mac / Windows — Download Uno Work, or one
 *            command; Linux — the command → "MacBook is connected" →
 *            purpose: "What is it for?" → bring: chats, projects, key names → done
 *
 * All of it talks to the cloud computer that holds the person's own computers
 * (`useComputersHostId`): the pairing (`myComputer.pair` + `pairStatus`), what
 * the computer is for (`computers.setPurpose`), its chats (`myComputer.import*`)
 * and its projects and key names (`computers.workScan` / `bringWork`). Until the
 * backend has the projects part, "Bring your work?" offers chats only.
 * SSH / address + code: Dev Mode only.
 *
 * The steps' contents are `ownComputerParts.tsx` (13.11): the guided setup's
 * "Move my projects here" shows the same parts inside its page. The window
 * keeps their state in the lifecycle store.
 */
import { ArrowLeftIcon, CheckIcon, CloudIcon, LaptopIcon, Loader2Icon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import { lifecycle, useLifecycle } from "../../computersLifecycle/store";
import { useComputerWork } from "../../computersLifecycle/useComputerWork";
import { useDevMode } from "../../devMode";
import { AddEnvModal } from "../AddEnvModal";
import { ThisMacPrompt } from "./ThisMacPrompt";
import { chatsLabel } from "../localComputer/chatImport.logic";
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
import {
  BringChoiceList,
  ConnectOwnComputer,
  LifecycleCard as Card,
  PurposeCards,
  useBringChoice,
  useComputerName,
  usePurposeChoice,
  type PairFlow,
} from "./ownComputerParts";

function BackTitle({ children, onBack }: { children: ReactNode; onBack?: () => void }) {
  return (
    <DialogTitle className="flex items-center gap-2 text-lg">
      {onBack ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Back"
          onClick={onBack}
          data-testid="lc-back"
        >
          <ArrowLeftIcon />
        </Button>
      ) : null}
      {children}
    </DialogTitle>
  );
}

// ── choose ──────────────────────────────────────────────────────────────

function ChooseStep() {
  const devMode = useDevMode();
  return (
    <div className="flex min-h-0 flex-col" data-testid="lc-add-choose">
      <DialogHeader>
        <BackTitle>Add computer</BackTitle>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-2">
        <Card
          icon={<CloudIcon />}
          title="Uno cloud computer"
          detail="Always on, agents ready."
          testId="lc-add-cloud"
          onClick={lifecycle.openCloud}
        />
        <Card
          icon={<LaptopIcon />}
          title="Your own computer"
          detail="Mac, Windows or Linux."
          testId="lc-add-own"
          onClick={() => lifecycle.go("own")}
        />
        {devMode ? (
          <button
            type="button"
            onClick={lifecycle.openCustom}
            data-testid="lc-add-ssh"
            className="mt-1 self-start text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Connect by SSH or address
          </button>
        ) : null}
      </DialogPanel>
    </div>
  );
}

// ── own: download or one command ────────────────────────────────────────

/** The window's pairing lives in the lifecycle store: it outlives a closed menu. */
function useStorePairFlow(): PairFlow {
  const os = useLifecycle((state) => state.os);
  const showCommand = useLifecycle((state) => state.showCommand);
  const pairing = useLifecycle((state) => state.pairing);
  const pairError = useLifecycle((state) => state.pairError);
  return useMemo(
    () => ({
      os,
      showCommand,
      pairing,
      pairError,
      setOs: lifecycle.setOs,
      revealCommand: lifecycle.showCommand,
      paired: lifecycle.paired,
      pairFailed: lifecycle.pairFailed,
      repair: lifecycle.repair,
      connected: lifecycle.connected,
    }),
    [os, pairError, pairing, showCommand],
  );
}

function OwnStep() {
  const flow = useStorePairFlow();
  return (
    <div className="flex min-h-0 flex-col" data-testid="lc-add-own-step">
      <DialogHeader>
        <BackTitle onBack={() => lifecycle.go("choose")}>Your own computer</BackTitle>
      </DialogHeader>
      <DialogPanel>
        <ConnectOwnComputer flow={flow} />
      </DialogPanel>
    </div>
  );
}

// ── purpose: what is it for ─────────────────────────────────────────────

function PurposeStep() {
  const computerId = useLifecycle((state) => state.computerId);
  const preselect = useLifecycle((state) => state.preselect);
  const name = useComputerName(computerId);
  const choice = usePurposeChoice({ computerId, preselect, onChosen: lifecycle.chosePurpose });
  return (
    <div className="flex min-h-0 flex-col" data-testid="lc-add-purpose">
      <DialogHeader>
        <BackTitle>
          <span className="grid size-7 place-items-center rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
            <CheckIcon className="size-4" />
          </span>
          {name} is connected
        </BackTitle>
        <DialogDescription>What is it for?</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <PurposeCards choice={choice} />
      </DialogPanel>
      {choice.confirming ? (
        <DialogFooter variant="bare">
          <Button
            disabled={choice.picked === null || choice.busy !== null}
            onClick={choice.confirm}
            data-testid="lc-purpose-continue"
          >
            {choice.busy !== null ? <Loader2Icon className="animate-spin" /> : null}
            Continue
          </Button>
        </DialogFooter>
      ) : null}
    </div>
  );
}

// ── bring: chats, projects, key names ───────────────────────────────────

function BringStep() {
  const computerId = useLifecycle((state) => state.computerId);
  const choice = useBringChoice(computerId);
  const bring = async () => {
    const started = await choice.bring();
    if (started) lifecycle.brought(started.brought);
  };
  return (
    <div className="flex min-h-0 flex-col" data-testid="lc-add-bring">
      <DialogHeader>
        <BackTitle>Bring your work?</BackTitle>
      </DialogHeader>
      <DialogPanel>
        <BringChoiceList choice={choice} />
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="ghost" onClick={() => lifecycle.brought(null)} data-testid="lc-bring-skip">
          Skip
        </Button>
        <Button
          disabled={choice.busy || choice.label === ""}
          onClick={() => void bring()}
          data-testid="lc-bring-start"
        >
          {choice.busy ? <Loader2Icon className="animate-spin" /> : null}
          {choice.label === "" ? "Bring" : `Bring ${choice.label}`}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ── done ────────────────────────────────────────────────────────────────

function DoneStep() {
  const computerId = useLifecycle((state) => state.computerId);
  const purpose = useLifecycle((state) => state.purposeChosen) ?? "tool";
  const brought = useLifecycle((state) => state.brought);
  const name = useComputerName(computerId);
  // Bringing goes on after the window closes; while it's open, it shows how it went.
  const bring = useComputerWork(brought && brought.projects.length > 0 ? computerId : null).status
    ?.bring;
  const bringing = bring?.state === "running";
  const failed = bring?.results.filter((result) => !result.ok) ?? [];
  return (
    <div className="flex min-h-0 flex-col" data-testid="lc-add-done">
      <DialogHeader>
        <BackTitle>
          <span className="grid size-7 place-items-center rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
            <CheckIcon className="size-4" />
          </span>
          {name} is ready
        </BackTitle>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-1.5 text-sm">
        <p className="text-muted-foreground">
          {purpose === "full"
            ? `Start a chat “on ${name}” from Home.`
            : "Your agents can use it while it’s on."}
        </p>
        {brought && brought.projects.length > 0 ? (
          <p data-testid="lc-done-projects">
            {brought.projects.join(", ")}
            <span className="text-muted-foreground">
              {bringing ? " · copying…" : " · On all my computers"}
            </span>
          </p>
        ) : null}
        {failed.map((result) => (
          <p key={result.path} role="alert" className="text-destructive">
            {result.name}: {result.message ?? "didn’t come over."}
          </p>
        ))}
        {brought && brought.chats > 0 ? (
          <p className="text-muted-foreground">{chatsLabel(brought.chats)} on their way.</p>
        ) : null}
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button onClick={lifecycle.close} data-testid="lc-done">
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

/** One for the whole app (mounted in the root, next to "Connect my computer"). */
export function AddComputerWindow() {
  const addOpen = useLifecycle((state) => state.addOpen);
  const step = useLifecycle((state) => state.step);
  const cloudOpen = useLifecycle((state) => state.cloudOpen);
  const customOpen = useLifecycle((state) => state.customOpen);
  return (
    <>
      <Dialog
        open={addOpen}
        onOpenChange={(next) => {
          if (!next) lifecycle.close();
        }}
      >
        <DialogPopup className="max-w-md" data-testid="lc-add-window">
          {step === "choose" ? <ChooseStep /> : null}
          {step === "own" ? <OwnStep /> : null}
          {step === "purpose" ? <PurposeStep /> : null}
          {step === "bring" ? <BringStep /> : null}
          {step === "done" ? <DoneStep /> : null}
        </DialogPopup>
      </Dialog>
      <ThisMacPrompt />
      <AddEnvModal open={cloudOpen} initialStep="uno" onOpenChange={lifecycle.setCloudOpen} />
      <AddEnvModal open={customOpen} initialStep="custom" onOpenChange={lifecycle.setCustomOpen} />
    </>
  );
}
