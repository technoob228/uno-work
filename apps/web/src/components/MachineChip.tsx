import { cva, type VariantProps } from "class-variance-authority";

import type { MachineKind } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { MACHINE_KIND_LABELS } from "~/plainLanguage";
import type { MachineIdentity } from "../machineIdentity";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * The short badge that says which machine a row belongs to.
 *
 * Tinted background plus coloured text, matching how the app's other status
 * badges are built, so a chip reads as part of the same family rather than as a
 * saturated block of colour in a sidebar full of text.
 *
 * Slot `0` is the neutral chip: machines past the third validated hue, and
 * machines whose slot has not been assigned yet. It is a first-class rendering,
 * not a failure state — the monogram is what identifies a machine, so a neutral
 * chip is still perfectly usable.
 */
const machineChipVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center rounded-[.3125rem] font-semibold leading-none tracking-tight",
  {
    defaultVariants: { size: "default", slot: 0 },
    variants: {
      size: {
        default: "size-[1.1875rem] text-[.59375rem]",
        sm: "size-[.9375rem] text-[.5rem]",
        lg: "size-6.5 rounded-[.4375rem] text-[.71875rem]",
      },
      slot: {
        0: "bg-muted text-muted-foreground",
        1: "bg-machine-1/16 text-machine-1-ink",
        2: "bg-machine-2/16 text-machine-2-ink",
        3: "bg-machine-3/16 text-machine-3-ink",
      },
    },
  },
);

type MachineChipSize = NonNullable<VariantProps<typeof machineChipVariants>["size"]>;

interface MachineChipProps {
  readonly identity: MachineIdentity;
  readonly size?: MachineChipSize | undefined;
  readonly className?: string | undefined;
  /**
   * Extra context for the tooltip — typically why the machine is stale or
   * offline. The label alone is not enough when a row is dimmed: the user needs
   * to know whether the data is old or the machine is gone.
   */
  readonly detail?: string | null | undefined;
  /** What the machine is; named in the tooltip ("hk-box · Uno box") when known. */
  readonly kind?: MachineKind | null | undefined;
  /** Set when the chip sits inside a control that already has a tooltip. */
  readonly withoutTooltip?: boolean | undefined;
}

function clampSlot(slot: number): 0 | 1 | 2 | 3 {
  return slot === 1 || slot === 2 || slot === 3 ? slot : 0;
}

export function MachineChip({
  identity,
  size = "default",
  className,
  detail,
  kind,
  withoutTooltip,
}: MachineChipProps) {
  const chip = (
    <span
      aria-label={identity.label}
      className={cn(machineChipVariants({ size, slot: clampSlot(identity.colorSlot) }), className)}
      data-slot="machine-chip"
      // `role="img"` so the accessible name is the machine's full label: a bare
      // span with aria-label is not reliably announced, and the monogram must
      // not be spelled out letter by letter in place of the name.
      role="img"
    >
      <span aria-hidden="true">{identity.monogram}</span>
    </span>
  );

  if (withoutTooltip === true) {
    return chip;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{chip}</TooltipTrigger>
      <TooltipPopup side="top">
        {[
          kind ? `${identity.label} · ${MACHINE_KIND_LABELS[kind]}` : identity.label,
          detail != null && detail.length > 0 ? detail : null,
        ]
          .filter((part) => part !== null)
          .join(" — ")}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Overlapping chips for a row that spans several machines (a repository checked
 * out in more than one place). Order follows slot assignment, so the same
 * repository always shows the same chips in the same sequence.
 */
export function MachineChipStack({
  identities,
  className,
  max = 4,
}: {
  readonly identities: ReadonlyArray<MachineIdentity>;
  readonly className?: string;
  readonly max?: number;
}) {
  if (identities.length === 0) {
    return null;
  }
  const shown = identities.slice(0, max);
  const overflow = identities.length - shown.length;
  return (
    <span
      className={cn("inline-flex items-center pl-1.5", className)}
      data-slot="machine-chip-stack"
    >
      {shown.map((identity) => (
        <MachineChip
          // Ringed in the surface colour so overlapping chips stay separable.
          // `ring-background`, not `ring-sidebar`: the shadcn sidebar's
          // `bg-sidebar` class is inert here (no `--color-sidebar` token is
          // defined), so the pane actually paints on the app background.
          className="-ml-1.5 ring-[1.5px] ring-background"
          identity={identity}
          key={identity.environmentId}
          size="sm"
        />
      ))}
      {overflow > 0 ? (
        <span className="ml-1 text-[.625rem] text-muted-foreground">+{overflow}</span>
      ) : null}
    </span>
  );
}
