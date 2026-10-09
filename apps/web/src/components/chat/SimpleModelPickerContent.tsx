/**
 * The model picker's popup without Dev mode (01.10): Uno AI (Smart, Fast,
 * Premium) and "Your subscription" (Claude / ChatGPT, when signed in). See
 * `simpleModelPicker.logic.ts`. Everything else — harness icons, the full
 * catalogue, filters — is the Dev mode picker (`ModelPickerContent`).
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, CrownIcon, SparklesIcon, ZapIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  isSimpleChoiceSelected,
  type SimpleModelChoice,
  type SimpleModelChoices,
} from "./simpleModelPicker.logic";

export function SimpleModelPickerContent(props: {
  choices: SimpleModelChoices;
  activeInstanceId: ProviderInstanceId;
  model: string;
  onPick: (instanceId: ProviderInstanceId, model: string) => void;
  /** "Use your Claude or ChatGPT subscription" when none is signed in here (Settings → AI). */
  onConnectSubscription?: () => void;
}) {
  const active = { instanceId: props.activeInstanceId, model: props.model };
  const premiumSelected = props.choices.premium.some((choice) =>
    isSimpleChoiceSelected(choice, active),
  );
  const [premiumOpen, setPremiumOpen] = useState(premiumSelected);
  // Which subscription's model list is open (Claude: Opus / Sonnet / …).
  const [subscriptionOpen, setSubscriptionOpen] = useState<string | null>(null);
  const premiumLabel = premiumSelected
    ? (props.choices.premium.find((choice) => isSimpleChoiceSelected(choice, active))?.label ??
      "Premium")
    : "Premium";

  const row = (choice: SimpleModelChoice, icon: ReactNode, nested = false) => (
    <button
      key={choice.key}
      type="button"
      role="option"
      aria-selected={isSimpleChoiceSelected(choice, active)}
      onClick={() => props.onPick(choice.instanceId, choice.model)}
      data-testid={`simple-model-${choice.label.toLowerCase().replace(/\s+/g, "-")}`}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-hidden transition-colors hover:bg-accent focus-visible:bg-accent",
        nested && "pl-9",
      )}
    >
      {nested ? null : (
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{choice.label}</span>
        {nested ? null : (
          <span className="block truncate text-xs text-muted-foreground">{choice.description}</span>
        )}
      </span>
      {isSimpleChoiceSelected(choice, active) ? (
        <CheckIcon className="size-4 shrink-0 text-primary" />
      ) : null}
    </button>
  );

  const hasUno = props.choices.included.length + props.choices.premium.length > 0;
  return (
    <div
      role="listbox"
      aria-label="Model"
      className="flex w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-1 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
      data-testid="simple-model-picker"
    >
      {hasUno ? <GroupLabel>Uno AI</GroupLabel> : null}
      {props.choices.included.map((choice) =>
        row(choice, /fast/i.test(choice.label) ? <ZapIcon /> : <SparklesIcon />),
      )}
      {props.choices.premium.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setPremiumOpen((value) => !value)}
            aria-expanded={premiumOpen}
            data-testid="simple-model-premium"
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-hidden transition-colors hover:bg-accent focus-visible:bg-accent"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-amber-500/10 text-amber-600 [&_svg]:size-3.5">
              <CrownIcon />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{premiumLabel}</span>
              <span className="block truncate text-xs text-muted-foreground">
                Claude, GPT and others · from premium credit, then your balance
              </span>
            </span>
            {premiumSelected ? <CheckIcon className="size-4 shrink-0 text-primary" /> : null}
            <ChevronDownIcon
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                premiumOpen && "rotate-180",
              )}
            />
          </button>
          {premiumOpen ? (
            <div className="flex max-h-56 flex-col overflow-y-auto">
              {props.choices.premium.map((choice) => row(choice, null, true))}
            </div>
          ) : null}
        </>
      ) : null}
      {props.choices.subscriptions.length > 0 ? (
        <>
          <GroupLabel>Your subscription</GroupLabel>
          {props.choices.subscriptions.map((choice) => {
            const selected = isSimpleChoiceSelected(choice, active);
            const open = subscriptionOpen === choice.key;
            const current = selected
              ? choice.models.find((option) => option.model === props.model)
              : undefined;
            return (
              <div key={choice.key} className="flex flex-col">
                <div className="flex items-center">
                  <div className="min-w-0 flex-1">
                    {row(
                      current ? { ...choice, description: current.label } : choice,
                      <ProviderInstanceIcon
                        driverKind={choice.driverKind}
                        displayName={choice.label}
                        iconClassName="size-4"
                      />,
                    )}
                  </div>
                  {choice.models.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setSubscriptionOpen(open ? null : choice.key)}
                      aria-expanded={open}
                      aria-label={`${choice.label} models`}
                      data-testid={`simple-model-${choice.label.toLowerCase()}-models`}
                      className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent"
                    >
                      <ChevronDownIcon
                        className={cn("size-3.5 transition-transform", open && "rotate-180")}
                      />
                    </button>
                  ) : null}
                </div>
                {open ? (
                  <div className="flex max-h-56 flex-col overflow-y-auto">
                    {choice.models.map((option) => row(option, null, true))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </>
      ) : props.onConnectSubscription ? (
        <button
          type="button"
          onClick={props.onConnectSubscription}
          data-testid="simple-model-connect-subscription"
          className="mt-0.5 w-full cursor-pointer rounded-lg px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Have Claude Pro / Max or ChatGPT Plus? Use your subscription — Uno doesn't charge for AI
          on it →
        </button>
      ) : null}
      <p className="px-2 pt-1 pb-0.5 text-[11px] leading-snug text-muted-foreground/80">
        Other agents and models: Settings → Developer → Dev mode.
      </p>
    </div>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-1.5 pb-0.5 text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground/70 uppercase">
      {children}
    </div>
  );
}
