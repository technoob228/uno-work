/**
 * A light PowerPoint reader: enough of a .pptx to draw each slide's text boxes
 * and pictures where they sit, in order. Not a renderer of themes, charts,
 * SmartArt or animations — the viewer says so and offers the download.
 *
 * Positions come from the shape itself or, for placeholders (titles, bodies),
 * from the matching placeholder on the slide's layout and then master — which
 * is where PowerPoint keeps them for slides made from a template.
 */
import JSZip from "jszip";

const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
};

export interface SlideBox {
  /** Position and size as fractions of the slide (0..1). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface SlideRun {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /** Points, when set on the run. */
  readonly size: number | null;
  readonly color: string | null;
}

export interface SlideParagraph {
  readonly runs: ReadonlyArray<SlideRun>;
  readonly bullet: boolean;
  readonly level: number;
  readonly align: "left" | "center" | "right";
}

export type SlideItem =
  | {
      readonly type: "text";
      readonly box: SlideBox | null;
      readonly role: "title" | "subtitle" | "body";
      readonly paragraphs: ReadonlyArray<SlideParagraph>;
    }
  | { readonly type: "image"; readonly box: SlideBox | null; readonly mediaPath: string };

export interface Slide {
  readonly index: number;
  readonly items: ReadonlyArray<SlideItem>;
  readonly notes: string;
}

export interface Presentation {
  /** Width / height. */
  readonly aspect: number;
  readonly slides: ReadonlyArray<Slide>;
  readonly zip: JSZip;
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

function children(parent: Element | Document, ns: string, local: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS(ns, local));
}

function directChild(parent: Element, ns: string, local: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.namespaceURI === ns && child.localName === local) return child;
  }
  return null;
}

function resolveTarget(fromPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const base = fromPath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") base.pop();
    else if (part !== ".") base.push(part);
  }
  return base.join("/");
}

function relsPathFor(partPath: string): string {
  const parts = partPath.split("/");
  const name = parts.pop()!;
  return [...parts, "_rels", `${name}.rels`].join("/");
}

async function readRels(
  zip: JSZip,
  partPath: string,
): Promise<Map<string, { target: string; type: string }>> {
  const rels = new Map<string, { target: string; type: string }>();
  const file = zip.file(relsPathFor(partPath));
  if (!file) return rels;
  const doc = parseXml(await file.async("text"));
  for (const rel of Array.from(doc.getElementsByTagName("Relationship"))) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target && rel.getAttribute("TargetMode") !== "External") {
      rels.set(id, {
        target: resolveTarget(partPath, target),
        type: rel.getAttribute("Type") ?? "",
      });
    }
  }
  return rels;
}

interface Placeholder {
  readonly type: string;
  readonly idx: string | null;
}

function placeholderOf(shape: Element): Placeholder | null {
  const ph = children(shape, NS.p, "ph")[0];
  if (!ph) return null;
  return { type: ph.getAttribute("type") ?? "body", idx: ph.getAttribute("idx") };
}

function boxOf(shape: Element, slideWidth: number, slideHeight: number): SlideBox | null {
  const xfrm = children(shape, NS.a, "xfrm")[0];
  const off = xfrm ? directChild(xfrm, NS.a, "off") : null;
  const ext = xfrm ? directChild(xfrm, NS.a, "ext") : null;
  if (!off || !ext) return null;
  const x = Number(off.getAttribute("x"));
  const y = Number(off.getAttribute("y"));
  const w = Number(ext.getAttribute("cx"));
  const h = Number(ext.getAttribute("cy"));
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return { x: x / slideWidth, y: y / slideHeight, w: w / slideWidth, h: h / slideHeight };
}

function placeholderBoxes(doc: Document, slideWidth: number, slideHeight: number) {
  const boxes: Array<{ ph: Placeholder; box: SlideBox }> = [];
  for (const shape of children(doc, NS.p, "sp")) {
    const ph = placeholderOf(shape);
    const box = boxOf(shape, slideWidth, slideHeight);
    if (ph && box) boxes.push({ ph, box });
  }
  return boxes;
}

function matchPlaceholder(
  ph: Placeholder,
  candidates: ReadonlyArray<{ ph: Placeholder; box: SlideBox }>,
): SlideBox | null {
  const normalize = (type: string) =>
    type === "ctrTitle" ? "title" : type === "subTitle" ? "body" : type;
  const byIdx = ph.idx !== null ? candidates.find((entry) => entry.ph.idx === ph.idx) : undefined;
  if (byIdx) return byIdx.box;
  return candidates.find((entry) => normalize(entry.ph.type) === normalize(ph.type))?.box ?? null;
}

function paragraphsOf(shape: Element): SlideParagraph[] {
  const body = children(shape, NS.p, "txBody")[0];
  if (!body) return [];
  return children(body, NS.a, "p").map((paragraph) => {
    const pPr = directChild(paragraph, NS.a, "pPr");
    const algn = pPr?.getAttribute("algn");
    const runs: SlideRun[] = [];
    for (const node of Array.from(paragraph.children)) {
      if (node.namespaceURI !== NS.a) continue;
      if (node.localName === "br") {
        runs.push({ text: "\n", bold: false, italic: false, size: null, color: null });
        continue;
      }
      if (node.localName !== "r" && node.localName !== "fld") continue;
      const text = directChild(node, NS.a, "t")?.textContent ?? "";
      const rPr = directChild(node, NS.a, "rPr");
      const sz = rPr?.getAttribute("sz");
      const color = rPr ? children(rPr, NS.a, "srgbClr")[0]?.getAttribute("val") : null;
      runs.push({
        text,
        bold: rPr?.getAttribute("b") === "1",
        italic: rPr?.getAttribute("i") === "1",
        size: sz ? Number(sz) / 100 : null,
        color: color ? `#${color}` : null,
      });
    }
    return {
      runs,
      bullet: pPr ? !directChild(pPr, NS.a, "buNone") && !!directChild(pPr, NS.a, "buChar") : false,
      level: Number(pPr?.getAttribute("lvl") ?? 0),
      align: algn === "ctr" ? "center" : algn === "r" ? "right" : "left",
    };
  });
}

export async function readPresentation(bytes: ArrayBuffer): Promise<Presentation> {
  const zip = await JSZip.loadAsync(bytes);
  const presentationFile = zip.file("ppt/presentation.xml");
  if (!presentationFile) throw new Error("This doesn't look like a PowerPoint file.");
  const presentation = parseXml(await presentationFile.async("text"));
  const size = children(presentation, NS.p, "sldSz")[0];
  const slideWidth = Number(size?.getAttribute("cx") ?? 12_192_000);
  const slideHeight = Number(size?.getAttribute("cy") ?? 6_858_000);
  const presentationRels = await readRels(zip, "ppt/presentation.xml");

  const slidePaths = children(presentation, NS.p, "sldId")
    .map((node) => presentationRels.get(node.getAttributeNS(NS.r, "id") ?? "")?.target)
    .filter((path): path is string => !!path && !!zip.file(path));

  const layoutCache = new Map<string, Array<{ ph: Placeholder; box: SlideBox }>>();
  const inherited = async (partPath: string) => {
    const cached = layoutCache.get(partPath);
    if (cached) return cached;
    const file = zip.file(partPath);
    const boxes = file
      ? placeholderBoxes(parseXml(await file.async("text")), slideWidth, slideHeight)
      : [];
    layoutCache.set(partPath, boxes);
    return boxes;
  };

  const slides: Slide[] = [];
  for (const [index, slidePath] of slidePaths.entries()) {
    const doc = parseXml(await zip.file(slidePath)!.async("text"));
    const rels = await readRels(zip, slidePath);
    const layoutPath = [...rels.values()].find((rel) => rel.type.endsWith("/slideLayout"))?.target;
    const layoutBoxes = layoutPath ? await inherited(layoutPath) : [];
    const masterPath = layoutPath
      ? [...(await readRels(zip, layoutPath)).values()].find((rel) =>
          rel.type.endsWith("/slideMaster"),
        )?.target
      : undefined;
    const masterBoxes = masterPath ? await inherited(masterPath) : [];

    const items: SlideItem[] = [];
    const tree = children(doc, NS.p, "spTree")[0];
    const shapes = tree ? Array.from(tree.querySelectorAll("*")) : [];
    for (const node of shapes) {
      if (node.namespaceURI !== NS.p) continue;
      if (node.localName === "sp") {
        const paragraphs = paragraphsOf(node);
        if (!paragraphs.some((paragraph) => paragraph.runs.some((run) => run.text.trim())))
          continue;
        const ph = placeholderOf(node);
        const box =
          boxOf(node, slideWidth, slideHeight) ??
          (ph ? (matchPlaceholder(ph, layoutBoxes) ?? matchPlaceholder(ph, masterBoxes)) : null);
        const role =
          ph?.type === "title" || ph?.type === "ctrTitle"
            ? "title"
            : ph?.type === "subTitle"
              ? "subtitle"
              : "body";
        items.push({ type: "text", box, role, paragraphs });
      } else if (node.localName === "pic") {
        const blip = children(node, NS.a, "blip")[0];
        const target = rels.get(blip?.getAttributeNS(NS.r, "embed") ?? "")?.target;
        if (target && zip.file(target)) {
          items.push({
            type: "image",
            box: boxOf(node, slideWidth, slideHeight),
            mediaPath: target,
          });
        }
      }
    }

    let notes = "";
    const notesPath = [...rels.values()].find((rel) => rel.type.endsWith("/notesSlide"))?.target;
    const notesFile = notesPath ? zip.file(notesPath) : null;
    if (notesFile) {
      const notesDoc = parseXml(await notesFile.async("text"));
      notes = children(notesDoc, NS.p, "sp")
        .filter((shape) => placeholderOf(shape)?.type === "body")
        .flatMap((shape) => paragraphsOf(shape))
        .map((paragraph) => paragraph.runs.map((run) => run.text).join(""))
        .join("\n")
        .trim();
    }
    slides.push({ index, items, notes });
  }

  return { aspect: slideWidth / slideHeight, slides, zip };
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
};

/** Browser-drawable media (EMF/WMF vector pictures are not). */
export function isDrawableMedia(path: string): boolean {
  return (path.split(".").pop()?.toLowerCase() ?? "") in IMAGE_TYPES;
}

export async function mediaObjectUrl(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  if (!file || !isDrawableMedia(path)) return null;
  const ext = path.split(".").pop()!.toLowerCase();
  const blob = new Blob([await file.async("arraybuffer")], {
    type: IMAGE_TYPES[ext] ?? "application/octet-stream",
  });
  return URL.createObjectURL(blob);
}
