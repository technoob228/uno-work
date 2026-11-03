/**
 * Variants (b) and (c) of the secondary path (SPEC "Запасной путь"): agents run
 * on the laptop itself — for offline work, the laptop's own AI plans, heavy
 * local models. The main path keeps the agent in the person's cloud.
 *
 *   (b) the desktop app only: Settings → This computer → "Where agents run";
 *       never in the web interface;
 *   (c) the same switch, shown only in Dev Mode.
 *
 * Variant (a) lives in the computer's menu (ComputerActions → Advanced).
 */
import { useComputersLifecycleDesktop } from "../../computersLifecycle/desktop";
import { lifecycle, useLifecycle } from "../../computersLifecycle/store";
import { COMPUTERS_LIFECYCLE } from "../../computersLifecycle/flag";
import { useDevMode } from "../../devMode";
import { cn } from "../../lib/utils";
import { SettingsSection } from "../settings/settingsLayout";
import { Radio, RadioGroup } from "../ui/radio-group";

/** The key the desktop app's own computer is kept under. */
export const THIS_DEVICE = "this-device";

/** Is "Settings → This computer" there (desktop app; variant b, or c with Dev Mode). */
export function useThisComputerSettingShown(): boolean {
  const desktop = useComputersLifecycleDesktop();
  const fallback = useLifecycle((state) => state.fallback);
  const devMode = useDevMode();
  if (!COMPUTERS_LIFECYCLE || !desktop) return false;
  return fallback === "b" || (fallback === "c" && devMode);
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
  const here = useLifecycle((state) => state.runsHere[THIS_DEVICE] === true);
  const fallback = useLifecycle((state) => state.fallback);
  if (!shown) return null;
  return (
    <SettingsSection title={fallback === "c" ? "This computer · Dev Mode" : "This computer"}>
      <div className="flex flex-col gap-3 px-4 py-4 sm:px-5" data-testid="lc-where-agents-run">
        <div className="text-sm font-medium">Where agents run</div>
        <RadioGroup
          value={here ? "here" : "cloud"}
          onValueChange={(value) => lifecycle.setRunsHere(THIS_DEVICE, value === "here")}
          className="gap-2"
        >
          <Choice
            value="cloud"
            title="In your cloud (recommended)"
            detail="Chats keep going when this Mac sleeps. Commands and files stay here."
            on={!here}
          />
          <Choice
            value="here"
            title="On this Mac"
            detail="Works offline and with this Mac’s own AI plans."
            on={here}
          />
        </RadioGroup>
      </div>
    </SettingsSection>
  );
}
