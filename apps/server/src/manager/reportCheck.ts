/**
 * "Uno names a file the person can't see." The instructions already send a
 * long result as a link (`report_publish`); this is the net under them, the
 * same scheme as `launchTruth.ts`: an answer naming a local document with no
 * link gets the report's link when one exists, else one hidden question back
 * to Uno. After that the answer goes as it is: an answer is never held back.
 *
 * @module manager/reportCheck
 */

/** Hidden report checks per message. */
export const REPORT_CHECK_MAX = 1;

const DOCUMENT_PATH =
  /(?:^|[\s«"'`(])((?:~\/|\/|\.{1,2}\/)?[\p{L}\p{N}_-][\p{L}\p{N}_./-]*\.(?:md|markdown|pdf|docx?|xlsx?|pptx?|html?|csv|txt))(?=$|[\s»"'`),.:;!?])/giu;

/** The local documents an answer names; empty when it carries any link. */
export const localDocumentsIn = (text: string): ReadonlyArray<string> => {
  if (/https?:\/\//i.test(text)) return [];
  const names = new Set<string>();
  for (const match of text.matchAll(DOCUMENT_PATH)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return [...names];
};

/** The answer with the report's link, when Uno forgot it. */
export const withReportLink = (text: string, url: string, language: "ru" | "en"): string =>
  `${text.trim()}\n\n[${language === "ru" ? "Отчёт" : "Report"}](${url})`;

export const reportCheckPromptText = (file: string): string =>
  `(Uno Work) Report check: your last answer names ${file}, a file the person can't see in Telegram or Slack. ` +
  "Nothing went to them yet. Call report_publish with this file now, then answer again: one screen, " +
  "the link as a word inside the text, no file names or paths.";
