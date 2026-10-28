/**
 * Signing the person's own agent in on this computer — "Put my AI agent on a
 * server" (flow-agent 15.10). One dialog for Home: the CLI's own sign-in
 * (HarnessSignInDialog: Claude Code's `claude auth login` link + the code to
 * paste back, Codex's device code), never a page of ours and never Uno signing
 * in for them (Misha 15.10: anything else risks the person's account).
 *
 * - Opens by itself once, on the first visit after the person picked their
 *   agent before Work (`?agent=claude|codex`, or an own-agent goal with the
 *   account's default AI on Claude / Codex) — `shouldAutoOpenAgentSignIn`.
 * - The Next step card's "Sign in to Claude Code" opens it too
 *   (`openAgentSignIn`).
 * - Signed in: new chats start on that agent (the "last picked" model, like
 *   setup's AI step — a fixed "New chats start on" still wins), and the account
 *   hears `agent_signed_in` once, so the console moves on as well.
 *
 * @module components/computer/home/HomeAgentSignIn
 */
import {
  ProviderInstanceId,
  type ProviderAuthDriver,
  type ServerProvider,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { create } from "zustand";

import { useAccountDefaultAi } from "../../../assistant/useAccountDefaultAi";
import { useComposerDraftStore } from "../../../composerDraftStore";
import { useSettings } from "../../../hooks/useSettings";
import { trackFunnel } from "../../../lib/funnel";
import { isWebLite } from "../../../lite/webLite";
import { resolveAppModelSelectionForInstance } from "../../../modelSelection";
import { useServerConfigReady, useServerProviders } from "../../../rpc/serverState";
import { arrivedAgent } from "../../../unoai/arrivedAgent";
import { HarnessSignInDialog } from "../../harness/HarnessSignInDialog";
import { useHarnessSetup } from "../../harness/useHarnessSetup";
import { goalState, withAnswer } from "../../setup/goals";
import { nextStepQuery } from "../../myuno/myUnoQueries";
import { parseNextStepPlan } from "./nextStep";
import { useSetupProgress, useUpdateSetupProgress } from "../../setup/useSetupProgress";
import {
  AGENT_LABEL,
  AGENT_PICK_KEY,
  AGENT_SIGNED_IN_MARK,
  AGENT_SIGNED_IN_SENT_KEY,
  AGENT_SIGN_IN_PROMPTED_KEY,
  agentDriverFromAccountDefault,
  noSignInAgent,
  parseAgentDriver,
  pickAgentDriver,
  shouldAutoOpenAgentSignIn,
  signedInWithOwnAccount,
} from "./agentStart";

interface AgentSignInState {
  readonly driver: ProviderAuthDriver | null;
  readonly open: (driver: ProviderAuthDriver) => void;
  readonly close: () => void;
}

const useAgentSignInStore = create<AgentSignInState>((set) => ({
  driver: null,
  open: (driver) => set({ driver }),
  close: () => set({ driver: null }),
}));

/** Opens the sign-in of this agent (the Next step card's button). */
export function openAgentSignIn(driver: ProviderAuthDriver): void {
  useAgentSignInStore.getState().open(driver);
}

export interface AgentOnComputer {
  /** The agent this person means (Claude Code unless something says otherwise). */
  readonly driver: ProviderAuthDriver;
  readonly label: string;
  readonly provider: ServerProvider | null;
  /** Signed in with the person's own subscription or key (not the plan's Uno AI credit). */
  readonly signedIn: boolean;
  /** Claude Code or Codex — whichever — signed in with the person's own account. */
  readonly anySignedIn: boolean;
  /**
   * The person's agent has no sign-in (OpenCode / Uno AI picked before Work):
   * it is ready as is, nothing to ask for.
   */
  readonly noSignIn: boolean;
}

/** The person's agent on this computer and whether it is signed in. */
export function useAgentOnComputer(ownAgentGoal: boolean): AgentOnComputer {
  const progress = useSetupProgress();
  const providers = useServerProviders();
  const accountDefaultAi = useAccountDefaultAi(ownAgentGoal && !isWebLite);
  const accountDefault = agentDriverFromAccountDefault(accountDefaultAi);
  const saved = parseAgentDriver(progress.answers[AGENT_PICK_KEY]);
  const arrived = arrivedAgent();
  const driver = pickAgentDriver({ arrived, saved, accountDefault });
  const noSignIn = noSignInAgent({ arrived, saved, accountDefaultAi }) !== null;
  return useMemo(() => {
    const byId = (id: ProviderAuthDriver) =>
      providers.find((entry) => entry.instanceId === ProviderInstanceId.make(id)) ?? null;
    const provider = byId(driver);
    return {
      driver,
      label: AGENT_LABEL[driver],
      provider,
      signedIn: signedInWithOwnAccount(provider),
      anySignedIn:
        signedInWithOwnAccount(byId("claudeAgent")) || signedInWithOwnAccount(byId("codex")),
      noSignIn,
    };
  }, [driver, noSignIn, providers]);
}

/** The person came for their own agent: the account's goal, or the one picked here. */
export function useOwnAgentGoal(): boolean {
  const progress = useSetupProgress();
  const backend = useQuery(nextStepQuery());
  const plan = useMemo(() => parseNextStepPlan(backend.data), [backend.data]);
  return plan?.goal === "own_agent" || goalState(progress).goal === "own_agent";
}

/** Mounted once next to Home (cloud and desktop computers; not lite). */
export function HomeAgentSignIn() {
  const ownAgentGoal = useOwnAgentGoal();
  const agent = useAgentOnComputer(ownAgentGoal);
  const progress = useSetupProgress();
  const update = useUpdateSetupProgress();
  const settingsReady = useServerConfigReady();
  const setup = useHarnessSetup();
  const settings = useSettings();
  const providers = useServerProviders();
  const setSticky = useComposerDraftStore((store) => store.setStickyModelSelection);
  const accountDefault = agentDriverFromAccountDefault(
    useAccountDefaultAi(ownAgentGoal && !isWebLite),
  );
  const openDriver = useAgentSignInStore((state) => state.driver);
  const close = useAgentSignInStore((state) => state.close);
  const answers = progress.answers;

  // The agent from the entry link stays known on this computer (the card's
  // button later, another browser).
  const arrived = arrivedAgent();
  useEffect(() => {
    if (!settingsReady || !arrived || answers[AGENT_PICK_KEY] === arrived) return;
    void update((current) => withAnswer(current, AGENT_PICK_KEY, arrived));
  }, [answers, arrived, settingsReady, update]);

  // The first visit after picking an agent: its sign-in opens by itself, once.
  const autoOpened = useRef(false);
  const autoOpen =
    settingsReady &&
    shouldAutoOpenAgentSignIn({
      lite: isWebLite,
      arrived,
      ownAgentGoal,
      accountDefault,
      prompted: answers[AGENT_SIGN_IN_PROMPTED_KEY] !== undefined,
      provider: agent.provider,
    });
  useEffect(() => {
    if (!autoOpen || autoOpened.current) return;
    autoOpened.current = true;
    useAgentSignInStore.getState().open(agent.driver);
    void update((current) =>
      withAnswer(current, AGENT_SIGN_IN_PROMPTED_KEY, new Date().toISOString()),
    );
  }, [agent.driver, autoOpen, update]);

  // Signed in (here, in Settings or a terminal): the account hears it once —
  // it closes "Sign in to your agent" for the console too.
  useEffect(() => {
    // An agent with no sign-in (OpenCode / Uno AI) is ready as is.
    if (!ownAgentGoal || !settingsReady || !(agent.anySignedIn || agent.noSignIn)) return;
    if (answers[AGENT_SIGNED_IN_SENT_KEY]) return;
    trackFunnel("next_step_clicked", {
      goal: "own_agent",
      props: { step_id: AGENT_SIGNED_IN_MARK },
    });
    void update((current) =>
      withAnswer(current, AGENT_SIGNED_IN_SENT_KEY, new Date().toISOString()),
    );
  }, [agent.anySignedIn, agent.noSignIn, answers, ownAgentGoal, settingsReady, update]);

  // A sign-in finished in this dialog: new chats start on that agent.
  const job = openDriver ? setup.authJobs[openDriver] : undefined;
  const stuck = useRef<string | null>(null);
  useEffect(() => {
    if (!openDriver || job?.state !== "succeeded" || stuck.current === openDriver) return;
    stuck.current = openDriver;
    const instanceId = ProviderInstanceId.make(openDriver);
    const model = resolveAppModelSelectionForInstance(instanceId, settings, providers, null);
    if (model) setSticky({ instanceId, model });
  }, [job?.state, openDriver, providers, setSticky, settings]);

  if (!openDriver) return null;
  return (
    <HarnessSignInDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      driver={openDriver}
      label={AGENT_LABEL[openDriver]}
      job={job}
      onStart={({ method, apiKey, restart }) =>
        void setup.startAuth({
          driver: openDriver,
          method,
          ...(apiKey ? { apiKey } : {}),
          ...(restart ? { restart } : {}),
        })
      }
      onCancel={() => void setup.cancelAuth(openDriver)}
      onSubmitCode={(code) => void setup.submitAuthCode({ driver: openDriver, code })}
      onReset={() => setup.clearAuth(openDriver)}
    />
  );
}
