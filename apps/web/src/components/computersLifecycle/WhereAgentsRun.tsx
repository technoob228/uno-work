/**
 * The secondary path (SPEC "Запасной путь", variant b — Misha didn't object to
 * the recommendation): agents run on the laptop itself — for offline work, the
 * laptop's own AI plans, heavy local models. The main path keeps the agent in
 * the person's cloud.
 *
 * Only in the desktop app, only once this Mac is one of the person's computers:
 * Settings → This computer → "Where agents run". Never in the web interface.
 *
 *   - In your cloud (recommended): "on <this Mac>" in a new chat is this Mac
 *     as one of the computers — the chat runs in the cloud, its commands and
 *     files here;
 *   - On this Mac: the new chat runs in this app's own Work on the Mac, as
 *     before the lifecycle.
 */
import type { DesktopConnectHelperState } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { lifecycleBackend } from "../../computersLifecycle/backend";
import { useComputersLifecycleDesktop } from "../../computersLifecycle/desktop";
import { useComputersLifecycleOn } from "../../computersLifecycle/flag";
import { lifecycle, useLifecycle } from "../../computersLifecycle/store";
import { useOwnComputers } from "../../computersLifecycle/useComputers";
import { cn } from "../../lib/utils";
import { SettingsSection } from "../settings/settingsLayout";
import { Radio, RadioGroup } from "../ui/radio-group";

const NOT_INSTALLED: DesktopConnectHelperState = { installed: false, computerId: null, name: null };

/** The desktop app: is this Mac one of the person's computers, and which. */
export function useThisMacHelper(): DesktopConnectHelperState {
  const desktop = useComputersLifecycleDesktop();
  return (
    useQuery({
      queryKey: ["computers", "this-mac-helper"],
      queryFn: () => lifecycleBackend.thisMacHelper(),
      enabled: desktop,
      staleTime: 30_000,
      retry: false,
    }).data ?? NOT_INSTALLED
  );
}

/** This Mac as one of the person's own computers (null: it isn't one, or not the desktop app). */
export function useThisMacComputerId(): string | null {
  const helper = useThisMacHelper();
  const { computers } = useOwnComputers();
  if (!helper.installed || helper.computerId === null) return null;
  return computers.some((one) => one.id === helper.computerId) ? helper.computerId : null;
}

/** Is "Settings → This computer" there (desktop app, lifecycle on, this Mac connected). */
export function useThisComputerSettingShown(): boolean {
  const on = useComputersLifecycleOn();
  const desktop = useComputersLifecycleDesktop();
  const thisMac = useThisMacComputerId();
  return on && desktop && thisMac !== null;
}

function Choice(props: { value: string; title: string; detail: string; on: boolean }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors",
        props.on ? "border-primary/60 bg-primary/5" : "border-border/70 hover:bg-accent/50",
      )}
      data-testid={`lc-where-${props.value}`}
    >
      <Radio value={props.value} className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{props.title}</span>
        <span className="text-xs text-muted-foreground">{props.detail}</span>
      </span>
    </label>
  );
}

export function WhereAgentsRunSection() {
  const shown = useThisComputerSettingShown();
  const where = useLifecycle((state) => state.whereAgentsRun);
  if (!shown) return null;
  return (
    <SettingsSection title="This computer">
      <div className="flex flex-col gap-3 px-4 py-4 sm:px-5" data-testid="lc-where-agents-run">
        <div className="text-sm font-medium">Where agents run</div>
        <RadioGroup
          value={where}
          onValueChange={(value) =>
            lifecycle.setWhereAgentsRun(value === "here" ? "here" : "cloud")
          }
          className="gap-2"
        >
          <Choice
            value="cloud"
            title="In your cloud (recommended)"
            detail="Chats keep going when this Mac sleeps. Commands and files stay here."
            on={where === "cloud"}
          />
          <Choice
            value="here"
            title="On this Mac"
            detail="Works offline and with this Mac’s own AI plans."
            on={where === "here"}
          />
        </RadioGroup>
      </div>
    </SettingsSection>
  );
}
