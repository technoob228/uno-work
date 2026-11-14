/**
 * Trust tiers on the MacBook (13.11), for the demo: what uno-work answers for
 * Settings → My computer, the manage card's journal and the Inbox's banner.
 * Two chats hold an Allow, a command runs now, and the journal has a line of
 * each kind of tier, a refused `docker compose up` among them.
 */
import type {
  MyComputerActivityEntry,
  MyComputerChatGrant,
  MyComputerTrustSettings,
  MyComputerTrustState,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";

const DEFAULTS: MyComputerTrustSettings = {
  allowedFolders: ["~/projects"],
  allowedCommands: ["make", "bun run dev", "npm run dev"],
  grantHours: 4,
  idleHours: 12,
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const minutesAhead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

let settings: MyComputerTrustSettings = {
  ...DEFAULTS,
  allowedFolders: ["~/projects", "~/Documents/Invoices"],
};
let paused: MyComputerTrustState["paused"] = null;
let running = 1;

function initialGrants(computerId: string): MyComputerChatGrant[] {
  return [
    {
      threadId: "t-mac-landing",
      threadTitle: "Fix the landing build",
      computerId,
      grantedAt: minutesAgo(35),
      expiresAt: minutesAhead(4 * 60 - 35),
    },
    {
      threadId: "t-mac-screens",
      threadTitle: "Rename screenshots by date",
      computerId,
      grantedAt: minutesAgo(130),
      expiresAt: minutesAhead(4 * 60 - 130),
    },
  ];
}

let grants: MyComputerChatGrant[] | null = null;

function journal(): MyComputerActivityEntry[] {
  const landing = { threadId: "t-mac-landing", threadTitle: "Fix the landing build" };
  const screens = { threadId: "t-mac-screens", threadTitle: "Rename screenshots by date" };
  return [
    { at: minutesAgo(0.2), kind: "run", summary: "bun run dev", ...landing, tier: "chat" },
    {
      at: minutesAgo(1),
      kind: "run",
      summary: "docker compose up",
      ...landing,
      tier: "blocked",
      outcome: "refused",
      reason: "Containers run in the cloud, not on the person’s computer",
    },
    {
      at: minutesAgo(2),
      kind: "run",
      summary: "bunx tsc --noEmit",
      ...landing,
      tier: "free",
      outcome: "ran",
      exitCode: 0,
      durationMs: 8_400,
    },
    {
      at: minutesAgo(3),
      kind: "write",
      summary: "~/projects/landing/src/Hero.tsx",
      ...landing,
      tier: "chat",
      outcome: "ran",
      durationMs: 40,
    },
    {
      at: minutesAgo(4),
      kind: "read",
      summary: "~/projects/landing/package.json",
      ...landing,
      tier: "free",
      outcome: "ran",
      durationMs: 12,
    },
    {
      at: minutesAgo(26),
      kind: "run",
      summary: "git push origin main",
      ...landing,
      tier: "always",
      outcome: "ran",
      exitCode: 0,
      durationMs: 2_100,
    },
    {
      at: minutesAgo(118),
      kind: "run",
      summary: "make test",
      ...screens,
      tier: "chat",
      outcome: "failed",
      exitCode: 2,
      durationMs: 14_300,
    },
    {
      at: minutesAgo(125),
      kind: "list",
      summary: "~/Desktop",
      ...screens,
      tier: "ask",
      outcome: "ran",
      durationMs: 30,
    },
  ];
}

function state(computerId: string): MyComputerTrustState {
  grants ??= initialGrants(computerId);
  return {
    settings,
    defaults: DEFAULTS,
    grants,
    paused,
    lastActivityAt: paused === null ? minutesAgo(0.2) : paused.at,
    running: paused === null ? running : 0,
  };
}

/** Undefined: not one of these RPCs. `mac`: the MacBook while it's connected. */
export function answerTrustRpc(
  tag: string,
  input: Record<string, unknown>,
  mac: { readonly id: string; readonly name: string } | null,
): unknown {
  const computerId = mac?.id ?? "41";
  switch (tag) {
    case WS_METHODS.myComputerActivity:
      return mac === null ? [] : journal();
    case WS_METHODS.myComputerTrust:
      return state(computerId);
    case WS_METHODS.myComputerSetTrust:
      settings = {
        allowedFolders: (input.allowedFolders as string[] | undefined) ?? settings.allowedFolders,
        allowedCommands:
          (input.allowedCommands as string[] | undefined) ?? settings.allowedCommands,
        grantHours: Number(input.grantHours ?? settings.grantHours),
        idleHours: Number(input.idleHours ?? settings.idleHours),
      };
      return state(computerId);
    case WS_METHODS.myComputerRevokeGrant:
      grants = state(computerId).grants.filter(
        (grant) => !(grant.threadId === input.threadId && grant.computerId === input.computerId),
      );
      return state(computerId);
    case WS_METHODS.myComputerStopAll: {
      // The demo keeps the MacBook listed: only the pause shows what happened.
      const stopped = paused === null ? running : 0;
      paused = { at: new Date().toISOString(), reason: "stopped" };
      running = 0;
      grants = [];
      return { stopped, disconnected: mac === null ? [] : [mac.name], failed: [] };
    }
    case WS_METHODS.myComputerResume:
      paused = null;
      return state(computerId);
    default:
      return undefined;
  }
}
