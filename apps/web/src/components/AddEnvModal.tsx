import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronLeftIcon, CloudIcon, GlobeIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogBackdrop, DialogPortal, DialogViewport } from "./ui/dialog";

interface AddEnvModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = "choice" | "uno" | "custom";

export function AddEnvModal({ open, onOpenChange }: AddEnvModalProps) {
  const [step, setStep] = useState<Step>("choice");

  const handleOpenChange = (next: boolean) => {
    if (!next) setStep("choice");
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPortal>
        <DialogBackdrop />
        <DialogViewport>
          <DialogPrimitive.Popup
            data-slot="dialog-popup"
            className="-translate-y-[calc(1.25rem*var(--nested-dialogs))] relative row-start-2 flex max-h-full min-h-0 w-full min-w-0 max-w-xl scale-[calc(1-0.1*var(--nested-dialogs))] flex-col rounded-2xl border bg-popover text-popover-foreground opacity-[calc(1-0.1*var(--nested-dialogs))] shadow-lg/5 transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            {step === "choice" && (
              <ChoiceStep onClose={() => handleOpenChange(false)} setStep={setStep} />
            )}
            {step === "uno" && (
              <SubStep
                title="Spin up an Uno VPS"
                description="Pick a region and size — we'll have it ready in ~30s."
                primaryLabel="Provision"
                onBack={() => setStep("choice")}
              />
            )}
            {step === "custom" && (
              <SubStep
                title="Connect a custom server"
                description="SSH credentials for your own machine."
                primaryLabel="Connect"
                onBack={() => setStep("choice")}
              />
            )}
          </DialogPrimitive.Popup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}

function ChoiceStep({ onClose, setStep }: { onClose: () => void; setStep: (step: Step) => void }) {
  return (
    <>
      <div className="flex flex-col gap-1 border-b border-border p-6">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl bg-primary/12 text-primary">
            <PlusIcon className="size-4" />
          </div>
          <div>
            <DialogPrimitive.Title className="font-heading font-semibold text-lg leading-none">
              Add a new environment
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-1 text-muted-foreground text-sm">
              Where should the agent run?
            </DialogPrimitive.Description>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 p-6">
        <button
          type="button"
          onClick={() => setStep("uno")}
          className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/4"
        >
          <div className="grid size-9 place-items-center rounded-lg bg-primary/12 text-primary">
            <CloudIcon className="size-4" />
          </div>
          <div className="font-medium text-sm">Uno VPS</div>
          <div className="text-muted-foreground text-xs leading-relaxed">
            Spin up a managed server in ~30s. Pre-installed harnesses, billed by Uno.
          </div>
          <Badge variant="outline" className="mt-auto self-start text-[10px]">
            Recommended
          </Badge>
        </button>
        <button
          type="button"
          onClick={() => setStep("custom")}
          className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/4"
        >
          <div className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
            <GlobeIcon className="size-4" />
          </div>
          <div className="font-medium text-sm">Custom server</div>
          <div className="text-muted-foreground text-xs leading-relaxed">
            Connect over SSH to your own VPS, dedicated box or home server.
          </div>
          <Badge variant="outline" className="mt-auto self-start text-[10px] text-muted-foreground">
            Bring your own
          </Badge>
        </button>
      </div>
      <div className="flex justify-end gap-2 border-t border-border bg-muted/40 px-6 py-4">
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </>
  );
}

function SubStep({
  title,
  description,
  primaryLabel,
  onBack,
}: {
  title: string;
  description: string;
  primaryLabel: string;
  onBack: () => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1 border-b border-border p-6">
        <DialogPrimitive.Title className="font-heading font-semibold text-lg leading-none">
          {title}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="mt-1 text-muted-foreground text-sm">
          {description}
        </DialogPrimitive.Description>
      </div>
      <div className="grid place-items-center px-6 py-12 text-center text-muted-foreground text-sm">
        <em>coming next</em>
      </div>
      <div className="flex justify-between gap-2 border-t border-border bg-muted/40 px-6 py-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeftIcon className="size-3.5" />
          Back
        </Button>
        <Button size="sm" disabled>
          {primaryLabel}
        </Button>
      </div>
    </>
  );
}
