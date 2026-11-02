/**
 * Does a file name match what the person typed? The computer searches with
 * this and the window filters the same answer with it: with a narrower test of
 * its own the window threw away what the computer had found ("утро" finds
 * utro-site, й matches a name macOS keeps as two code points).
 */
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

/** macOS keeps й and ё as two code points, a person types them as one. */
const foldName = (name: string) => name.normalize("NFC").toLocaleLowerCase();

/**
 * What to look for: the words as typed and, for a Russian query, in Latin
 * letters, the way agents name folders ("утро" finds utro-site).
 */
export function fileNameNeedles(query: string): ReadonlyArray<string> {
  const typed = foldName(query.trim());
  const latin = Array.from(typed, (letter) => CYRILLIC_TO_LATIN[letter] ?? letter).join("");
  return latin === typed ? [typed] : [typed, latin];
}

export function fileNameMatches(name: string, needles: ReadonlyArray<string>): boolean {
  const folded = foldName(name);
  return needles.some((needle) => folded.includes(needle));
}
