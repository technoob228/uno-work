/**
 * Where a chat starts for someone who came for their own agent (goal
 * `own_agent`): the agent picked before Work (`?agent=` or the pick saved
 * here), or — with OpenCode / Uno AI picked in the configurator, the
 * account's `default_ai` — OpenCode first. One answer for Home's box and for
 * "New chat" (28.10, 0.0.155: Home knew it, New chat still opened on
 * "uno · Smart"). Null for everyone else, and when Uno AI itself was picked
 * (the machine's own default is that).
 */
import { useMemo } from "react";

import { useAccountDefaultAi } from "../../../assistant/useAccountDefaultAi";
import { isWebLite } from "../../../lite/webLite";
import { arrivedAgent } from "../../../unoai/arrivedAgent";
import { useSetupProgress } from "../../setup/useSetupProgress";
import { AGENT_PICK_KEY, noSignInAgent, parseAgentDriver } from "./agentStart";
import { useOwnAgentGoal } from "./HomeAgentSignIn";
import type { OwnAgentStart } from "./homeStartModel";

export function useOwnAgentStart(enabled = true): OwnAgentStart | null {
  const ownAgentGoal = useOwnAgentGoal() && enabled;
  const pickedAgent = parseAgentDriver(useSetupProgress().answers?.[AGENT_PICK_KEY]);
  const accountDefaultAi = useAccountDefaultAi(ownAgentGoal && !isWebLite);
  return useMemo(() => {
    if (!ownAgentGoal) return null;
    const noSignIn = noSignInAgent({
      arrived: arrivedAgent(),
      saved: pickedAgent,
      accountDefaultAi,
    });
    if (noSignIn === "uno") return null;
    return { picked: pickedAgent, openCodeFirst: noSignIn === "opencode" };
  }, [accountDefaultAi, ownAgentGoal, pickedAgent]);
}
