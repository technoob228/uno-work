import JSZip from "jszip";

/**
 * Обход бага x2t: в xlsx со строками `t="inlineStr"` (так пишут openpyxl,
 * pandas, многие генераторы — то есть агенты на машине) движок теряет каждую
 * строковую ячейку, идущую сразу после другой inline-строки: строка
 * `1 | a | b` открывается как `1 | a | (пусто)`. Файлы Excel/LibreOffice
 * (sharedStrings) не страдают. Проверено 22.09.2026 на сборке движка web-local
 * release-13, см. reports/day_2026-09-22/office_roundtrip.
 *
 * Перед открытием переписываем простые inline-строки в `t="str"` с `<v>` —
 * так движок читает их корректно. Файл на диске не трогаем: при сохранении
 * движок всё равно пишет строки через sharedStrings.
 * Rich-text inline-строки (`<is><r>…`) не трогаем — их openpyxl не пишет.
 */
const INLINE_CELL = /t="inlineStr"(\s[^>]*)?>\s*<is>\s*<t(?:\s[^>]*)?>([\s\S]*?)<\/t>\s*<\/is>/g;
const INLINE_CELL_EMPTY = /t="inlineStr"(\s[^>]*)?>\s*<is>\s*<t(?:\s[^>]*)?\/>\s*<\/is>/g;

export function rewriteInlineStrings(sheetXml: string): string {
  return sheetXml
    .replace(
      INLINE_CELL,
      (_m, rest: string | undefined, text: string) => `t="str"${rest ?? ""}><v>${text}</v>`,
    )
    .replace(INLINE_CELL_EMPTY, (_m, rest: string | undefined) => `t="str"${rest ?? ""}><v></v>`);
}

export async function normalizeXlsxForEngine(bytes: Uint8Array): Promise<Uint8Array> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return bytes; // не zip — пусть движок сам скажет, что файл битый
  }
  const sheets = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name));
  let changed = false;
  for (const name of sheets) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async("string");
    if (!xml.includes('t="inlineStr"')) continue;
    const next = rewriteInlineStrings(xml);
    if (next !== xml) {
      zip.file(name, next);
      changed = true;
    }
  }
  if (!changed) return bytes;
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
