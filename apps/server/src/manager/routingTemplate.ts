/**
 * ROUTING.md — the assistant's table of which AI does which task — as Uno
 * ships it, and the one silent upgrade of its notes.
 *
 * 0.0.160 and before said "No Claude on this computer? Use Uno AI instead:
 * … uno/uno/smart". Asked to "start a chat through Claude", Uno started it on
 * Smart without a word, though the person's table said Claude (Misha 29.10).
 * The person's word now wins: what they name, and their `you` rows, are
 * used as they are; a harness that isn't ready here is a one-line question,
 * never a quiet swap.
 *
 * @module manager/routingTemplate
 */
import { ROUTING_PERSON_RULE } from "@t3tools/shared/assistantMemory";

/** The "No Claude here" note of 0.0.106 – 0.0.160, exactly as written into ROUTING.md. */
export const LEGACY_NO_CLAUDE_NOTE = `- No Claude on this computer (no subscription)? Use Uno AI instead: harness
  \`uno\`, model \`uno/uno/smart\` where the table says Sonnet or Haiku, the
  newest Premium Opus-class model of the Uno model list where it says Opus.`;

/** What replaces it (2026-10-29). */
export const PERSON_FIRST_NOTE = `- The person's word wins: a harness or model they name ("through Claude",
  "on Opus") or a row with Source \`you\` is used as it is — never another
  model in silence. Check \`settings_read\` → \`harnessReadiness\` first. Not
  ready here (not installed / not signed in)? Ask in ONE line and wait:
  "Claude isn't connected on this computer — connect it (Settings → Agents →
  Sign in) or run it on <model>?"
- Only a \`default\` row whose harness isn't ready, and the person named
  none: Uno AI — harness \`uno\`, model \`uno/uno/smart\` where the table says
  Sonnet or Haiku, the newest Premium Opus-class model of the Uno model list
  where it says Opus — and say which model in your one line.`;

export const ROUTING_TEMPLATE = `# Routing table — which harness/model for which task

Starting point by Uno; the person edits it on your page, you tune it from
real outcomes. Cheapest thing that reliably does the job wins.

${ROUTING_PERSON_RULE}

| Task type | Harness | Model | Effort | Source | Why |
|---|---|---|---|---|---|
| Quick questions, status | self | — | — | default | answer yourself, no chat |
| Simple tasks, small fixes | claudeAgent | claude-sonnet-5-5 | medium | default | reliable and cheap |
| Anything with UI | claudeAgent | claude-opus-5-5 | high | default | taste and detail |
| Hard bugs, architecture | claudeAgent | claude-opus-5-5 | max | default | strongest reasoning |
| Reading code, summaries | claudeAgent | claude-haiku-4-5 | low | default | grunt work |

Notes:
- Harness \`self\` = answer in this chat, do not start a thread.
${PERSON_FIRST_NOTE}
- A model this computer doesn't offer: take the newest one of the same
  family (opus / sonnet / haiku).
- Effort → harness option: claude → options.effort (low, medium, high, max),
  codex → options.reasoningEffort (low, medium, high, xhigh for max).

## Outcomes log

<!-- date | task type | harness/model/effort | ok/failed/escalated | evidence/note -->

## Proposals

<!-- - task type → harness model effort | why | YYYY-MM-DD — waits for the person's yes -->

## Declined

<!-- - YYYY-MM-DD task type → harness model effort — not again for 14 days -->
`;

/**
 * An existing ROUTING.md with the old note swapped for the new one — only
 * when the old note is there word for word (nobody edited it); anything else
 * comes back unchanged (null: nothing to do).
 */
export function upgradeRoutingNotes(content: string): string | null {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.includes(LEGACY_NO_CLAUDE_NOTE)) return null;
  return normalized.replace(LEGACY_NO_CLAUDE_NOTE, PERSON_FIRST_NOTE);
}
