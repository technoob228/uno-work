/**
 * "Help" in the account menu: where a person finds a person. Fix Work for what
 * Uno can look into itself, Telegram and email for us, and the API docs last,
 * for those who came for them (qa 30.10: Help opened a page about POST
 * /api/v1/agent/connect, and there was no one to write to).
 */
import { SUPPORT_EMAIL, SUPPORT_TELEGRAM } from "@t3tools/shared/supportDraft";
import { BookOpenIcon, MailIcon, SendIcon, WrenchIcon, type LucideIcon } from "lucide-react";

import { CONSOLE_URL } from "../../account/accountOverview";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { openExternal } from "./SidebarDAccountButton";

const COPY = {
  title: "Get help",
  description: "Something's off, or you have a question? We read everything.",
  fixWork: "Fix Work",
  fixWorkLine: "Uno finds what's wrong on this computer and tries safe fixes.",
  telegram: "Write to us on Telegram",
  email: "Email us",
  developers: "API docs for developers",
} as const;

function HelpRow(props: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly line: string;
  readonly testId: string;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      data-testid={props.testId}
      onClick={props.onClick}
      className="flex w-full items-start gap-3 rounded-lg border border-border/70 px-3 py-2.5 text-left transition-colors hover:bg-accent"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{props.title}</span>
        <span className="block text-xs text-muted-foreground">{props.line}</span>
      </span>
    </button>
  );
}

export function GetHelpDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onFixWork: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md" data-testid="get-help-dialog">
        <DialogHeader>
          <DialogTitle>{COPY.title}</DialogTitle>
          <DialogDescription>{COPY.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <HelpRow
            icon={WrenchIcon}
            title={COPY.fixWork}
            line={COPY.fixWorkLine}
            testId="get-help-fix-work"
            onClick={() => {
              props.onOpenChange(false);
              props.onFixWork();
            }}
          />
          <HelpRow
            icon={SendIcon}
            title={COPY.telegram}
            line={`@${SUPPORT_TELEGRAM}`}
            testId="get-help-telegram"
            onClick={() => openExternal(`https://t.me/${SUPPORT_TELEGRAM}`)}
          />
          <HelpRow
            icon={MailIcon}
            title={COPY.email}
            line={SUPPORT_EMAIL}
            testId="get-help-email"
            onClick={() => openExternal(`mailto:${SUPPORT_EMAIL}`)}
          />
          <button
            type="button"
            data-testid="get-help-docs"
            onClick={() => openExternal(`${CONSOLE_URL}/docs`)}
            className="flex items-center gap-1.5 px-1 pt-2 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <BookOpenIcon className="size-3.5" />
            {COPY.developers}
          </button>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
