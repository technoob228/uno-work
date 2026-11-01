/**
 * "Connect your AI or other computers" under Home's box (Misha 01.11): two
 * ways out of one line — this computer goes to an AI that lives elsewhere (MCP),
 * or another computer comes in here (the Add computer flow).
 */
import { BotIcon, ChevronRightIcon, LaptopIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";

function Choice(props: {
  icon: ReactNode;
  title: string;
  detail: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      data-testid={props.testId}
      className="flex w-full items-center gap-3 rounded-xl border border-border/60 bg-card/40 p-3 text-left transition-colors hover:bg-accent"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
        {props.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{props.title}</span>
        <span className="text-xs text-muted-foreground">{props.detail}</span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function ConnectChoiceDialog({
  open,
  onOpenChange,
  onUseFromAi,
  onAddComputer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUseFromAi: () => void;
  onAddComputer: () => void;
}) {
  const pick = (next: () => void) => {
    onOpenChange(false);
    next();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect your AI or other computers</DialogTitle>
          <DialogDescription>What do you want to connect?</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            <Choice
              icon={<BotIcon />}
              title="Use this computer from your AI"
              detail="Claude, ChatGPT, Cursor or Codex work on it over MCP."
              testId="connect-choice-ai"
              onClick={() => pick(onUseFromAi)}
            />
            <Choice
              icon={<LaptopIcon />}
              title="Add another computer"
              detail="Connect one you own, or start a new one in the cloud."
              testId="connect-choice-computer"
              onClick={() => pick(onAddComputer)}
            />
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
