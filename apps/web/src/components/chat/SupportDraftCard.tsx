/**
 * The letter Fix Work left in the chat. The person can change it, copy it or
 * open it in their mail app. The app sends nothing.
 */
import {
  SUPPORT_EMAIL,
  supportDraftFitsMailto,
  supportDraftMailtoUrl,
  type SupportDraft,
} from "@t3tools/shared/supportDraft";
import { CheckIcon, CopyIcon, MailIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { openExternal } from "../sidebar/SidebarDAccountButton";
import { Textarea } from "../ui/textarea";

export function SupportDraftCard({ draft }: { draft: SupportDraft }) {
  const [body, setBody] = useState(draft.body);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const fits = supportDraftFitsMailto(body);
  return (
    <section
      aria-label="Letter to support"
      data-testid="support-draft"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      <header className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-sm font-semibold">Letter to support</h3>
        <p className="truncate text-xs text-muted-foreground">
          To {SUPPORT_EMAIL} · {draft.subject}
        </p>
      </header>
      <Textarea
        aria-label="Letter"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        className="max-h-80 min-h-40 text-sm"
      />
      <p className="text-xs text-muted-foreground">
        Not sent. Read it, then send it yourself.
        {draft.redactions > 0
          ? ` Uno took out ${draft.redactions === 1 ? "1 thing" : `${draft.redactions} things`} that looked like a key.`
          : ""}
        {fits ? "" : " It's too long for a mail link: copy the rest."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          data-testid="support-draft-mail"
          onClick={() =>
            openExternal(supportDraftMailtoUrl({ subject: draft.subject, body }))
          }
        >
          <MailIcon />
          Open in mail
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="support-draft-copy"
          onClick={() =>
            copyToClipboard(
              `To: ${SUPPORT_EMAIL}\nSubject: ${draft.subject}\n\n${body}`,
              undefined,
            )
          }
        >
          {isCopied ? <CheckIcon /> : <CopyIcon />}
          {isCopied ? "Copied" : "Copy"}
        </Button>
      </div>
    </section>
  );
}
