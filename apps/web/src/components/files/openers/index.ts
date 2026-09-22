/**
 * Registers the openers Files ships with. Called once when the Files screen
 * loads; other code (an office engine, a plugin) registers on top with a
 * higher `match` score.
 */
import { registerFileOpener } from "../fileOpeners";
import { mediaOpeners } from "./mediaOpeners";
import { officeOpeners } from "./officeOpeners";
import { sheetOpeners } from "./sheetOpeners";
import { htmlEditor, textOpeners } from "./textOpeners";

let registered = false;

export function registerBuiltInFileOpeners(): void {
  if (registered) return;
  registered = true;
  for (const opener of mediaOpeners) {
    registerFileOpener(
      opener.id === "builtin.html" ? { ...opener, Editor: htmlEditor, editLabel: "Edit" } : opener,
    );
  }
  for (const opener of [...textOpeners, ...sheetOpeners, ...officeOpeners]) {
    registerFileOpener(opener);
  }
}
