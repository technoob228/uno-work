/**
 * Network (12.11.2026, Misha: "a visible button somewhere in Work — VPN /
 * Network, enable or disable, that's it"; then "the protocol should be
 * selectable: OpenVPN, Amnezia, WireGuard"). The switch lives on top of the
 * sidebar, next to Search: while it is on the person always sees from where
 * Uno Work goes online (🇩🇪 DE). One click opens the panel: the switch, the
 * exit, the protocol, and what it does on each of the account's computers.
 * Exit and protocol open their own lists inside the same panel.
 * Everything comes from this computer's daemon (`lib/networkApi.ts`);
 * a daemon without the route hides the button.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloudIcon,
  InfoIcon,
  KeyRoundIcon,
  LaptopIcon,
  LoaderCircleIcon,
  ServerIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from "lucide-react";
import { memo, type ReactNode, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { cn } from "../../lib/utils";
import {
  ADDRESS_TYPE_LABEL,
  type NetworkAddressType,
  type NetworkChange,
  type NetworkComputer,
  type NetworkExit,
  type NetworkProtocol,
  type NetworkState,
  PROTOCOL_HINT,
  PROTOCOL_LABEL,
  currentExit,
  exitCarries,
  flagOf,
  getNetwork,
  protocolSummary,
  setNetwork,
} from "../../lib/networkApi";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const NETWORK_KEY = ["uno-network"] as const;

const PROTOCOLS: ReadonlyArray<NetworkProtocol> = ["auto", "wireguard", "amneziawg", "openvpn"];

function useNetwork(environmentId: EnvironmentId | null) {
  return useQuery({
    queryKey: [...NETWORK_KEY, environmentId ?? ""],
    queryFn: () => getNetwork({ environmentId: environmentId! }),
    enabled: environmentId !== null,
    retry: false,
    staleTime: 2_000,
    // Coming up: ask every second until it's on (or down); else now and then.
    refetchInterval: (query) => (query.state.data?.status === "connecting" ? 1_000 : 15_000),
  });
}

function useSetNetwork(environmentId: EnvironmentId | null) {
  const queryClient = useQueryClient();
  const key = [...NETWORK_KEY, environmentId ?? ""];
  return useMutation({
    mutationFn: (change: NetworkChange) => setNetwork({ environmentId: environmentId!, ...change }),
    // The switch moves at once; the daemon's answer replaces the guess.
    onMutate: async (change) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData<NetworkState>(key);
      if (before) {
        const enabled = change.enabled ?? (change.exitId !== undefined ? true : before.enabled);
        const status = enabled ? "connecting" : "off";
        queryClient.setQueryData<NetworkState>(key, {
          ...before,
          enabled,
          exitId: change.exitId ?? before.exitId,
          protocol: change.protocol ?? before.protocol,
          activeProtocol: null,
          status,
          computers: before.computers.map((computer) =>
            computer.status === "asleep" ? computer : { ...computer, status },
          ),
        });
      }
      return { before };
    },
    onError: (_error, _change, context) => {
      if (context?.before) queryClient.setQueryData(key, context.before);
    },
    onSuccess: (state) => queryClient.setQueryData(key, state),
  });
}

/** What the trigger and the popover say about the state, in one place. */
export function networkHeadline(state: NetworkState): string {
  const exit = currentExit(state);
  const where = exit ? exitPlace(exit) : "the chosen exit";
  if (state.enabled && state.permission === "needed") return "Waiting for your OK in macOS";
  switch (state.status) {
    case "on":
      return `On · from ${where}`;
    case "connecting":
      return `Connecting to ${where}…`;
    case "down":
      return `${exit?.label ?? "The exit"} doesn't answer`;
    default:
      return "Off";
  }
}

function exitPlace(exit: NetworkExit): string {
  return exit.kind === "uno" && exit.city ? `${exit.label}, ${exit.city}` : exit.label;
}

const TRIGGER_BASE =
  "no-drag inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md text-xs font-semibold outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4";

function NetworkTrigger(props: { state: NetworkState; compact: boolean }) {
  const { state, compact } = props;
  const exit = currentExit(state);
  const code = exit?.country?.toUpperCase() ?? "";
  if (state.status === "off") {
    return (
      <span
        className={cn(
          TRIGGER_BASE,
          compact ? "size-9 justify-center rounded-lg [&_svg]:size-[18px]" : "w-7 justify-center",
          "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground data-[popup-open]:bg-sidebar-row-hover",
        )}
      >
        <ShieldIcon />
      </span>
    );
  }
  const tone =
    state.status === "down"
      ? "bg-destructive/10 text-destructive-foreground hover:bg-destructive/16"
      : state.status === "connecting"
        ? "bg-warning/12 text-warning-foreground hover:bg-warning/18"
        : "bg-success/10 text-success-foreground hover:bg-success/16";
  return (
    <span
      className={cn(
        TRIGGER_BASE,
        compact ? "size-9 justify-center rounded-lg [&_svg]:size-[18px]" : "px-2",
        tone,
      )}
    >
      {state.status === "down" ? (
        <ShieldAlertIcon />
      ) : state.status === "connecting" ? (
        <LoaderCircleIcon className="animate-spin" />
      ) : (
        <ShieldCheckIcon />
      )}
      {compact || !exit ? null : code ? (
        <span className="tabular-nums">
          {flagOf(exit.country)} {code}
        </span>
      ) : (
        <span className="max-w-[4.5rem] truncate">{exit.label}</span>
      )}
    </span>
  );
}

function ExitIcon(props: { exit: NetworkExit }) {
  const { exit } = props;
  if (exit.kind === "uno") {
    return <span className="text-base leading-none">{flagOf(exit.country) || "🌐"}</span>;
  }
  const icon: Record<Exclude<NetworkExit["kind"], "uno">, ReactNode> = {
    computer: <CloudIcon />,
    server: <ServerIcon />,
    config: <KeyRoundIcon />,
  };
  return icon[exit.kind];
}

const ADDRESS_BADGE: Record<NetworkAddressType, string> = {
  clean: "bg-success/10 text-success-foreground",
  datacenter: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
};

/** "Clean" / "Datacenter": how sites see the address. */
function AddressBadge(props: { type: NetworkAddressType }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-px text-[10px] font-medium",
        ADDRESS_BADGE[props.type],
      )}
    >
      {ADDRESS_TYPE_LABEL[props.type]}
    </span>
  );
}

const ROW =
  "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function SectionTitle(props: { children: ReactNode; first?: boolean }) {
  return (
    <div
      className={cn(
        "px-2 pb-0.5 text-[11px] font-medium text-muted-foreground",
        props.first ? "pt-1" : "pt-2",
      )}
    >
      {props.children}
    </div>
  );
}

function ExitRow(props: {
  exit: NetworkExit;
  protocol: NetworkProtocol;
  selected: boolean;
  onPick: () => void;
}) {
  const { exit, selected } = props;
  // A config brings its own protocol; with another one chosen it can't be picked.
  const carries = exit.kind !== "config" || exitCarries(exit, props.protocol);
  const own = exit.kind === "config" ? (exit.protocols[0] ?? null) : null;
  const sub = !exit.online
    ? "Offline"
    : !carries && own
      ? `${PROTOCOL_LABEL[own]} only`
      : exit.kind === "uno"
        ? (exit.city ?? "")
        : [flagOf(exit.country), exit.address, own ? `· ${PROTOCOL_LABEL[own]}` : null]
            .filter(Boolean)
            .join(" ");
  return (
    <button
      type="button"
      disabled={!exit.online || !carries}
      onClick={props.onPick}
      aria-pressed={selected}
      data-testid={`network-exit-${exit.id}`}
      className={cn(ROW, selected ? "bg-accent" : "hover:bg-accent")}
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
        <ExitIcon exit={exit} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{exit.label}</span>
          <AddressBadge type={exit.addressType} />
        </span>
        <span
          className={cn(
            "block truncate text-[11px] text-muted-foreground",
            exit.kind !== "uno" && exit.online && carries && "font-mono",
          )}
        >
          {sub}
        </span>
      </span>
      {exit.latencyMs !== null && exit.online && carries ? (
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {exit.latencyMs} ms
        </span>
      ) : null}
      <CheckIcon
        className={cn("size-4 shrink-0 text-primary", selected ? "opacity-100" : "opacity-0")}
      />
    </button>
  );
}

function ProtocolRow(props: {
  protocol: NetworkProtocol;
  exit: NetworkExit | null;
  selected: boolean;
  onPick: () => void;
}) {
  const { protocol, exit, selected } = props;
  const carries = !exit || exitCarries(exit, protocol);
  return (
    <button
      type="button"
      disabled={!carries}
      onClick={props.onPick}
      aria-pressed={selected}
      data-testid={`network-protocol-${protocol}`}
      className={cn(ROW, "items-start py-2", selected ? "bg-accent" : "hover:bg-accent")}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          {PROTOCOL_LABEL[protocol]}
          {protocol === "auto" ? (
            <span className="rounded bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground">
              Recommended
            </span>
          ) : null}
        </span>
        <span className="block text-[11px] leading-snug text-muted-foreground">
          {carries ? PROTOCOL_HINT[protocol] : `${exit?.label ?? "This exit"} doesn't carry it`}
        </span>
      </span>
      <CheckIcon
        className={cn(
          "mt-0.5 size-4 shrink-0 text-primary",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
    </button>
  );
}

/** "Exit  🇩🇪 Germany, Frankfurt  ›" — a line of the main view that opens a list. */
function PickRow(props: { label: string; value: ReactNode; testId: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      data-testid={props.testId}
      className={cn(ROW, "hover:bg-accent")}
    >
      <span className="w-16 shrink-0 text-xs text-muted-foreground">{props.label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-sm font-medium text-foreground">
        {props.value}
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

const COMPUTER_DOT: Record<NetworkComputer["status"], string> = {
  on: "bg-success",
  connecting: "bg-warning",
  down: "bg-destructive",
  off: "bg-muted-foreground/40",
  asleep: "bg-muted-foreground/40",
  permission: "bg-warning",
};

function computerSays(computer: NetworkComputer): string {
  switch (computer.status) {
    case "on":
      return computer.kind === "cloud" ? "The whole computer" : "Uno Work and Docker";
    case "connecting":
      return "Connecting…";
    case "down":
      return "Offline until the exit answers";
    case "asleep":
      return "Asleep · joins when it wakes";
    case "permission":
      return "Waiting for your OK in macOS";
    default:
      return "Own connection";
  }
}

function ComputerRow(props: { computer: NetworkComputer }) {
  const { computer } = props;
  return (
    <div
      className="flex items-center gap-2.5 px-2 py-1"
      data-testid={`network-computer-${computer.id}`}
    >
      <span className="grid size-6 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
        {computer.kind === "cloud" ? <CloudIcon /> : <LaptopIcon />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">
          {computer.name}
          {computer.current ? (
            <span className="text-muted-foreground"> · this computer</span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn("size-1.5 shrink-0 rounded-full", COMPUTER_DOT[computer.status])} />
          <span className="truncate">{computerSays(computer)}</span>
        </span>
      </span>
    </div>
  );
}

function SubHeader(props: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1 px-1.5 pb-1.5">
      <button
        type="button"
        onClick={props.onBack}
        aria-label="Back"
        data-testid="network-back"
        className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
      >
        <ChevronLeftIcon />
      </button>
      <span className="text-sm font-semibold text-foreground">{props.title}</span>
    </div>
  );
}

type PanelView = "main" | "exits" | "protocol";

function ExitsView(props: {
  state: NetworkState;
  onBack: () => void;
  onPick: (exitId: string) => void;
}) {
  const { state } = props;
  const uno = state.exits.filter((item) => item.kind === "uno");
  const own = state.exits.filter((item) => item.kind !== "uno");
  const row = (item: NetworkExit) => (
    <ExitRow
      key={item.id}
      exit={item}
      protocol={state.protocol}
      selected={item.id === state.exitId}
      onPick={() => props.onPick(item.id)}
    />
  );
  return (
    <div className="flex flex-col" data-testid="network-exits">
      <SubHeader title="Exit" onBack={props.onBack} />
      <p className="border-t border-border px-3 pt-2.5 pb-1 text-[11px] leading-snug text-muted-foreground">
        <span className="font-medium text-foreground">Clean</span> addresses belong to home internet
        providers, so sites trust them.{" "}
        <span className="font-medium text-foreground">Datacenter</span> ones belong to hosting
        companies: more captchas, and some sites block them.
      </p>
      <div className="px-1.5">
        {uno.length > 0 ? (
          <>
            <SectionTitle first>Uno addresses</SectionTitle>
            {uno.map(row)}
          </>
        ) : null}
        {own.length > 0 ? (
          <>
            <SectionTitle first={uno.length === 0}>Your computers and servers</SectionTitle>
            {own.map(row)}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ProtocolView(props: {
  state: NetworkState;
  onBack: () => void;
  onPick: (protocol: NetworkProtocol) => void;
}) {
  const { state } = props;
  const exit = currentExit(state);
  return (
    <div className="flex flex-col" data-testid="network-protocols">
      <SubHeader title="Protocol" onBack={props.onBack} />
      <div className="border-t border-border px-1.5 pt-1.5">
        {PROTOCOLS.map((protocol) => (
          <ProtocolRow
            key={protocol}
            protocol={protocol}
            exit={exit}
            selected={protocol === state.protocol}
            onPick={() => props.onPick(protocol)}
          />
        ))}
      </div>
      <div className="mt-1.5 border-t border-border px-3 pt-2.5 text-[11px] leading-snug text-muted-foreground">
        Auto starts with WireGuard and moves to AmneziaWG or OpenVPN when the network blocks it.
      </div>
    </div>
  );
}

function MainView(props: {
  state: NetworkState;
  onToggle: (enabled: boolean) => void;
  onOpen: (view: PanelView) => void;
  onAllow: () => void;
}) {
  const { state } = props;
  const exit = currentExit(state);
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3 px-3 pb-2.5">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-[18px]",
            state.status === "on"
              ? "bg-success/12 text-success-foreground"
              : state.status === "down"
                ? "bg-destructive/10 text-destructive-foreground"
                : "bg-muted text-muted-foreground",
          )}
        >
          {state.status === "down" ? <ShieldAlertIcon /> : <ShieldCheckIcon />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">Network</div>
          <div className="text-xs text-muted-foreground" data-testid="network-headline">
            {networkHeadline(state)}
          </div>
        </div>
        <Switch
          checked={state.enabled}
          onCheckedChange={(checked) => props.onToggle(checked)}
          aria-label="Network"
          data-testid="network-switch"
          className="mt-1"
        />
      </div>

      {state.enabled && state.permission === "needed" ? (
        <div
          className="mx-3 mb-2.5 rounded-md bg-warning/10 px-2.5 py-2 text-xs text-warning-foreground"
          data-testid="network-permission"
        >
          <p>
            macOS asks once to let Uno Work hold its connection. Until then Uno Work on this Mac
            stays offline, so nothing goes around the tunnel.
          </p>
          <Button size="xs" className="mt-2" onClick={props.onAllow} data-testid="network-allow">
            Allow in macOS
          </Button>
        </div>
      ) : null}
      {state.status === "down" ? (
        <div className="mx-3 mb-2.5 rounded-md bg-destructive/8 px-2.5 py-2 text-xs text-destructive-foreground">
          Uno Work is offline until it answers, so your own address doesn't leak. Pick another exit
          or turn Network off.
        </div>
      ) : null}

      <div className="border-t border-border px-1.5 py-1.5">
        <PickRow
          label="Exit"
          testId="network-row-exit"
          onOpen={() => props.onOpen("exits")}
          value={
            exit ? (
              <>
                {exit.kind === "uno" ? `${flagOf(exit.country)} ` : null}
                {exitPlace(exit)}
              </>
            ) : (
              "Choose"
            )
          }
        />
        <PickRow
          label="Protocol"
          testId="network-row-protocol"
          onOpen={() => props.onOpen("protocol")}
          value={protocolSummary(state)}
        />
        {state.status === "on" && exit?.address ? (
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <span className="w-16 shrink-0 text-xs text-muted-foreground">Sites see</span>
            <span className="min-w-0 flex-1 truncate text-right font-mono text-sm font-medium text-foreground">
              {exit.address}
            </span>
            <AddressBadge type={exit.addressType} />
          </div>
        ) : null}
      </div>

      {state.computers.length > 0 ? (
        <div className="border-t border-border px-1.5 pt-1.5" data-testid="network-computers">
          <SectionTitle first>Your computers</SectionTitle>
          {state.computers.map((computer) => (
            <ComputerRow key={computer.id} computer={computer} />
          ))}
        </div>
      ) : null}

      {state.otherVpn ? (
        <div
          className="mx-3 mt-2 flex gap-2 rounded-md bg-muted px-2.5 py-2 text-[11px] leading-snug text-muted-foreground [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0"
          data-testid="network-other-vpn"
        >
          <InfoIcon />
          <span>
            <span className="font-medium text-foreground">{state.otherVpn.name}</span> is on too.
            Uno's tunnel runs inside it, so your company's internal sites don't open from Uno Work
            while Network is on.
          </span>
        </div>
      ) : null}

      <div className="mt-1.5 border-t border-border px-3 pt-2.5 text-[11px] leading-snug text-muted-foreground">
        Everything Uno Work does goes through the tunnel: agents, terminals, git, ssh, downloads,
        and Docker on this computer. Nothing goes around it. Other apps keep their own connection.
      </div>
    </div>
  );
}

function NetworkPanel(props: { state: NetworkState; onChange: (change: NetworkChange) => void }) {
  const { state } = props;
  const [view, setView] = useState<PanelView>("main");
  const back = () => setView("main");
  return (
    <div className="flex flex-col" data-testid="network-panel" data-view={view}>
      {view === "exits" ? (
        <ExitsView
          state={state}
          onBack={back}
          onPick={(exitId) => {
            props.onChange({ exitId });
            back();
          }}
        />
      ) : view === "protocol" ? (
        <ProtocolView
          state={state}
          onBack={back}
          onPick={(protocol) => {
            if (protocol !== state.protocol) props.onChange({ protocol });
            back();
          }}
        />
      ) : (
        <MainView
          state={state}
          onToggle={(enabled) => props.onChange({ enabled })}
          onOpen={setView}
          onAllow={() => props.onChange({ askPermission: true })}
        />
      )}
    </div>
  );
}

/**
 * The button on top of the sidebar: a shield while off; the exit's flag and
 * country while on. Nothing at all where the daemon has no Network.
 */
export const SidebarDNetworkButton = memo(function SidebarDNetworkButton(props: {
  side?: "bottom" | "right";
}) {
  const environmentId = usePrimaryEnvironmentId();
  const { data: state } = useNetwork(environmentId);
  const change = useSetNetwork(environmentId);
  const [open, setOpen] = useState(false);
  if (!state?.available) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label={`Network: ${networkHeadline(state)}`}
              data-testid="sidebar-network"
              data-status={state.status}
              className="no-drag shrink-0 rounded-md outline-hidden"
            />
          }
        >
          <NetworkTrigger state={state} compact={props.side === "right"} />
        </TooltipTrigger>
        <TooltipPopup side={props.side ?? "bottom"}>
          {state.status === "off"
            ? "Network is off · Uno Work uses this computer's own connection"
            : `Network · ${networkHeadline(state)}`}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup
        side={props.side ?? "bottom"}
        align="start"
        className="w-[min(21rem,calc(100vw-1.5rem))] p-0 [--viewport-inline-padding:0px]"
      >
        {/* Mounted per opening: the panel always opens on its main view. */}
        {open ? <NetworkPanel state={state} onChange={(next) => change.mutate(next)} /> : null}
      </PopoverPopup>
    </Popover>
  );
});
