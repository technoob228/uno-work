/**
 * The name of a new document (Misha 16.10 p.9): created at once, no name
 * asked. "Untitled.docx" → the first free "Untitled 1.docx", "Untitled
 * 2.docx", … in that folder; any other template ("index.html") keeps its
 * name while it is free, then "index 2.html", "index 3.html", ….
 * Names compare case-insensitively (a Mac or Windows disk would clash).
 */
export function untitledFileName(template: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const name of taken) used.add(name.toLowerCase());
  const dot = template.lastIndexOf(".");
  const base = dot > 0 ? template.slice(0, dot) : template;
  const extension = dot > 0 ? template.slice(dot) : "";
  const numbered = base === "Untitled";
  if (!numbered && !used.has(template.toLowerCase())) return template;
  for (let n = numbered ? 1 : 2; ; n += 1) {
    const candidate = `${base} ${n}${extension}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
