/**
 * Words of the "This chat read text from outside" note (`OutsideTextNote`).
 * Where the text came from is read off the chat's own messages: the server's
 * `automations/prompt.ts` writes "…typed into the form on <site>" or "The
 * body of the webhook request" before the `<outside_input_…>` block. A
 * Telegram group member's message has no block: then it just says "outside".
 */
export type OutsideTextSource = "site form" | "webhook" | "both" | null;

export function outsideTextSource(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): OutsideTextSource {
  let form = false;
  let webhook = false;
  for (const message of messages) {
    if (message.role !== "user" || !message.text.includes("<outside_input_")) continue;
    if (message.text.includes("into the form on ")) form = true;
    if (message.text.includes("The body of the webhook request")) webhook = true;
  }
  if (form && webhook) return "both";
  if (form) return "site form";
  if (webhook) return "webhook";
  return null;
}

export function outsideTextNoteLine(source: OutsideTextSource): string {
  const from =
    source === "site form"
      ? " (a site form)"
      : source === "webhook"
        ? " (a webhook)"
        : source === "both"
          ? " (a site form and a webhook)"
          : "";
  return `This chat read text from outside${from}. Uno Work tools ask you first.`;
}
