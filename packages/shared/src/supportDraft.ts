/**
 * The letter to support an agent drafts in "Fix Work": an activity in the chat
 * that the app shows as a card. The person reads it and sends it themselves;
 * nothing here sends anything.
 */
export const SUPPORT_DRAFT_TOOL_NAME = "support_draft";
export const SUPPORT_DRAFT_ACTIVITY_KIND = "support.draft";
export const SUPPORT_EMAIL = "hello@getuno.xyz";
export const SUPPORT_DRAFT_MAX_SUBJECT = 200;
export const SUPPORT_DRAFT_MAX_BODY = 6_000;
/** Mail apps cut or refuse longer `mailto:` links; the rest goes by Copy. */
const MAILTO_MAX_BODY = 1_500;

export interface SupportDraft {
  readonly subject: string;
  readonly body: string;
  /** How many things that looked like keys the daemon took out. */
  readonly redactions: number;
}

export function readSupportDraft(value: unknown): SupportDraft | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { subject, body, redactions } = value as Record<string, unknown>;
  if (typeof subject !== "string" || typeof body !== "string") return undefined;
  return {
    subject,
    body,
    redactions: typeof redactions === "number" && Number.isFinite(redactions) ? redactions : 0,
  };
}

/** Whether the letter fits a `mailto:` link whole. */
export function supportDraftFitsMailto(body: string): boolean {
  return body.length <= MAILTO_MAX_BODY;
}

export function supportDraftMailtoUrl(draft: Pick<SupportDraft, "subject" | "body">): string {
  const body = supportDraftFitsMailto(draft.body)
    ? draft.body
    : `${draft.body.slice(0, MAILTO_MAX_BODY)}\n\n[Cut here: paste the rest of the letter from Uno Work.]`;
  const query = `subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(body)}`;
  return `mailto:${SUPPORT_EMAIL}?${query}`;
}
