import type { WorkArtifactFormat, WorkCapabilityFlags } from "@octant/contracts/work-artifacts";
import {
  WorkAdapterBudgetError,
  registerWorkFormatAdapter,
  type WorkFormatAdapter,
} from "./workFormatAdapter";
import { MAX_WORK_OUTPUT_BYTES } from "./workBudget";
import { readWorkZip, writeWorkZip, type WorkZipEntry } from "./workZipPort";

/**
 * PPTX (OOXML presentation) format adapter for Work. Materializes valid
 * minimal `.pptx` containers from markdown-deck content using the
 * dependency-free OPC ZIP port, and decodes slide text back into a
 * markdown-deck for round-trip read. Slide-level text (title + body bullets)
 * round-trips; transitions, media, themes, and pixel-perfect layout are not
 * guaranteed and the domain policy already marks pptx as inherently limited
 * fidelity. PPTX→markdown-deck is advertised as a lossy derived export format.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const REL_OFFICE_DOC =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const REL_SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const CT_PPTX_MAIN =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";

/**
 * Maximum number of slides the encoder will materialize. A request under the
 * 16 MiB input budget can contain hundreds of thousands of tiny slide blocks;
 * bounding the slide count before building ZIP entries prevents unbounded XML
 * expansion from exhausting memory before the mutation service's output budget
 * check can reject the result.
 */
const MAX_PPTX_SLIDE_COUNT = 10_000;

interface SlideContent {
  readonly title: string;
  readonly bullets: readonly string[];
}

/**
 * Parse markdown-deck text into slides. Slides are separated by a line whose
 * trimmed content is `---`. Each slide's first heading line (starting with
 * `#`) becomes the title (leading `#` and spaces stripped); remaining
 * non-empty lines become body bullets (a leading `-` or `*` is stripped when
 * present).
 */
function parseMarkdownDeck(content: string): SlideContent[] {
  const lines = content.split(/\r?\n/);
  const slides: SlideContent[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "---") {
      slides.push(parseSlide(current));
      current = [];
    } else {
      current.push(line);
    }
  }
  slides.push(parseSlide(current));
  return slides.filter((slide) => slide.title !== "" || slide.bullets.length > 0);
}

function parseSlide(lines: readonly string[]): SlideContent {
  let title = "";
  const bullets: string[] = [];
  let titleFound = false;
  for (const line of lines) {
    if (!titleFound && line.trimStart().startsWith("#")) {
      title = line
        .trimStart()
        .replace(/^#+\s*/, "")
        .trim();
      titleFound = true;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const bullet = trimmed.replace(/^[-*]\s*/, "");
    bullets.push(bullet);
  }
  return { title, bullets };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSlideXml(slide: SlideContent, index: number): string {
  const titleText = escapeXml(slide.title);
  const bodyRuns = slide.bullets
    .map(
      (bullet) =>
        `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(bullet)}</a:t></a:r></a:p>`,
    )
    .join("");
  const bodyParagraphs =
    bodyRuns.length > 0 ? bodyRuns : `<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    `<p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    buildTitleShape(index, titleText) +
    buildBodyShape(index, bodyParagraphs) +
    `</p:spTree></p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:sld>`
  );
}

function buildTitleShape(index: number, titleText: string): string {
  // Shape IDs must be unique within a slide. The group shape (p:grpSp) already
  // uses p:cNvPr id="1", so user shapes start at 2.
  const spId = 2;
  return (
    `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="${spId}" name="Title ${index}"/>` +
    `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><p:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></p:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>` +
    `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${titleText}</a:t></a:r></a:p>` +
    `</p:txBody></p:sp>`
  );
}

function buildBodyShape(index: number, bodyParagraphs: string): string {
  // Shape IDs must be unique within a slide. The group shape uses id="1" and
  // the title shape uses id="2", so the body shape uses id="3".
  const spId = 3;
  return (
    `<p:sp>` +
    `<p:nvSpPr><p:cNvPr id="${spId}" name="Content ${index}"/>` +
    `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr><p:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4572000"/></p:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>` +
    bodyParagraphs +
    `</p:txBody></p:sp>`
  );
}

function buildPresentationXml(slideCount: number): string {
  const sldIds = Array.from({ length: slideCount }, (_, i) => {
    const n = i + 1;
    return `<p:sldId id="${256 + i}" r:id="rId${n}"/>`;
  }).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
    `<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>` +
    `<p:notesSz cx="6858000" cy="9144000"/>` +
    `</p:presentation>`
  );
}

function buildPresentationRels(slideCount: number): string {
  const rels = Array.from({ length: slideCount }, (_, i) => {
    const n = i + 1;
    return `<Relationship Id="rId${n}" Type="${REL_SLIDE}" Target="slides/slide${n}.xml"/>`;
  }).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rels +
    `</Relationships>`
  );
}

function buildContentTypes(slideCount: number): string {
  const slideOverrides = Array.from({ length: slideCount }, (_, i) => {
    const n = i + 1;
    return `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${CT_SLIDE}"/>`;
  }).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT_PPTX_MAIN}"/>` +
    slideOverrides +
    `</Types>`
  );
}

function buildRootRels(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL_OFFICE_DOC}" Target="ppt/presentation.xml"/>` +
    `</Relationships>`
  );
}

function encodePptx(content: string): Uint8Array {
  const slides = parseMarkdownDeck(content);
  if (slides.length === 0) {
    throw new Error("PPTX encode: markdown-deck has no slides");
  }
  if (slides.length > MAX_PPTX_SLIDE_COUNT) {
    throw new WorkAdapterBudgetError(
      `PPTX encode: slide count ${slides.length} exceeds maximum ${MAX_PPTX_SLIDE_COUNT}`,
    );
  }
  const entries: WorkZipEntry[] = [
    { name: "[Content_Types].xml", data: textEncoder.encode(buildContentTypes(slides.length)) },
    { name: "_rels/.rels", data: textEncoder.encode(buildRootRels()) },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: textEncoder.encode(buildPresentationRels(slides.length)),
    },
    {
      name: "ppt/presentation.xml",
      data: textEncoder.encode(buildPresentationXml(slides.length)),
    },
  ];
  let accumulatedXmlBytes = 0;
  for (const entry of entries) {
    accumulatedXmlBytes += entry.data.byteLength;
  }
  for (let i = 0; i < slides.length; i += 1) {
    const n = i + 1;
    const slide = slides[i];
    if (slide === undefined) continue;
    const slideXml = buildSlideXml(slide, i);
    const slideBytes = textEncoder.encode(slideXml);
    accumulatedXmlBytes += slideBytes.byteLength;
    if (accumulatedXmlBytes > MAX_WORK_OUTPUT_BYTES) {
      throw new WorkAdapterBudgetError(
        "PPTX encode: accumulated XML size exceeds output budget before ZIP compression",
      );
    }
    entries.push({
      name: `ppt/slides/slide${n}.xml`,
      data: slideBytes,
    });
  }
  return writeWorkZip(entries);
}

/**
 * Extract text runs from a single slide shape's XML fragment. Collects all
 * `<a:t>...</a:t>` contents in document order and joins them per paragraph.
 */
function extractShapeText(shapeXml: string): string[] {
  const paragraphs: string[] = [];
  const paraRegex = /<a:p>([\s\S]*?)<\/a:p>/g;
  let paraMatch: RegExpExecArray | null;
  while ((paraMatch = paraRegex.exec(shapeXml)) !== null) {
    const paraBody = paraMatch[1] ?? "";
    const runRegex = /<a:t>([\s\S]*?)<\/a:t>/g;
    let runMatch: RegExpExecArray | null;
    let paraText = "";
    while ((runMatch = runRegex.exec(paraBody)) !== null) {
      paraText += unescapeXml(runMatch[1] ?? "");
    }
    if (paraText !== "") paragraphs.push(paraText);
  }
  return paragraphs;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parse a slide's XML into title and body bullets. Splits the shape tree into
 * `<p:sp>` shapes, classifies each by its placeholder type, and extracts text
 * runs. Returns empty content when no title/body placeholder is found.
 */
function parseSlideXml(xml: string): SlideContent {
  let title = "";
  const bullets: string[] = [];
  const shapeRegex = /<p:sp>([\s\S]*?)<\/p:sp>/g;
  let shapeMatch: RegExpExecArray | null;
  while ((shapeMatch = shapeRegex.exec(xml)) !== null) {
    const shape = shapeMatch[1] ?? "";
    const phMatch = /<p:ph\s+[^>]*type="([^"]*)"/.exec(shape);
    const phType = phMatch?.[1];
    const texts = extractShapeText(shape);
    if (phType === "title" && texts.length > 0) {
      title = texts[0] ?? "";
    } else if (phType === "body") {
      for (const text of texts) bullets.push(text);
    }
  }
  return { title, bullets };
}

/**
 * Resolve the ordered list of slide part paths from the presentation XML and
 * its rels. Parses `ppt/presentation.xml` for `<p:sldIdLst>` to get the `r:id`
 * values in presentation order, then maps each `r:id` to a target path via
 * `ppt/_rels/presentation.xml.rels`. Returns `undefined` when the presentation
 * part or the slide-id list is missing so the caller can fall back to
 * filename-sort ordering.
 */
function resolveSlideOrderFromPresentation(entries: Map<string, Uint8Array>): string[] | undefined {
  const presData = entries.get("ppt/presentation.xml");
  if (presData === undefined) return undefined;
  const presXml = textDecoder.decode(presData);
  const sldIdLstMatch = /<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/.exec(presXml);
  if (sldIdLstMatch === null) return undefined;
  const ridRegex = /r:id="([^"]*)"/g;
  const rids: string[] = [];
  let ridMatch: RegExpExecArray | null;
  while ((ridMatch = ridRegex.exec(sldIdLstMatch[1] ?? "")) !== null) {
    rids.push(ridMatch[1] ?? "");
  }
  if (rids.length === 0) return undefined;
  const relsData = entries.get("ppt/_rels/presentation.xml.rels");
  if (relsData === undefined) return undefined;
  const relsXml = textDecoder.decode(relsData);
  const relRegex = /<Relationship\s+([^>]*)\/?\s*>/g;
  const relMap = new Map<string, string>();
  let relMatch: RegExpExecArray | null;
  while ((relMatch = relRegex.exec(relsXml)) !== null) {
    const attributes = relMatch[1] ?? "";
    const id = /(?:^|\s)Id="([^"]*)"/.exec(attributes)?.[1];
    const target = /(?:^|\s)Target="([^"]*)"/.exec(attributes)?.[1];
    if (id !== undefined && target !== undefined) relMap.set(id, target);
  }
  const paths: string[] = [];
  for (const rid of rids) {
    const target = relMap.get(rid);
    if (target === undefined) return undefined;
    paths.push(`ppt/${target}`);
  }
  return paths;
}

function decodePptx(bytes: Uint8Array): string | undefined {
  let entries: Map<string, Uint8Array>;
  try {
    entries = readWorkZip(bytes);
  } catch {
    return undefined;
  }
  const slidePattern = /^ppt\/slides\/slide(\d+)\.xml$/;
  const orderedPaths = resolveSlideOrderFromPresentation(entries);
  let slideXmls: string[];
  if (orderedPaths !== undefined && orderedPaths.length > 0) {
    slideXmls = [];
    for (const path of orderedPaths) {
      const data = entries.get(path);
      if (data === undefined) return undefined;
      slideXmls.push(textDecoder.decode(data));
    }
  } else {
    const slideEntries: Array<{ index: number; xml: string }> = [];
    for (const [name, data] of entries) {
      const match = slidePattern.exec(name);
      if (match) {
        slideEntries.push({
          index: Number.parseInt(match[1] ?? "0", 10),
          xml: textDecoder.decode(data),
        });
      }
    }
    if (slideEntries.length === 0) return undefined;
    slideEntries.sort((a, b) => a.index - b.index);
    slideXmls = slideEntries.map((entry) => entry.xml);
  }

  const slideTexts: string[] = [];
  for (const xml of slideXmls) {
    const slide = parseSlideXml(xml);
    const lines: string[] = [];
    if (slide.title !== "") lines.push(`# ${slide.title}`);
    for (const bullet of slide.bullets) lines.push(`- ${bullet}`);
    if (lines.length === 0) lines.push("# Untitled");
    slideTexts.push(lines.join("\n"));
  }
  return slideTexts.join("\n---\n");
}

const pptxAdapter: WorkFormatAdapter = {
  format: "pptx" as WorkArtifactFormat,
  encode: encodePptx,
  decode: decodePptx,
  capabilities: {
    canRead: true,
    canCreate: true,
    canMutate: true,
    canRoundTrip: false,
    canExport: true,
    canVersion: true,
  } satisfies WorkCapabilityFlags,
  exportFormats: ["markdown-deck"],
  convertTo: (targetFormat, sourceBytes) => {
    if (targetFormat === "pptx") return sourceBytes;
    if (targetFormat === "markdown-deck") {
      const deck = decodePptx(sourceBytes);
      if (deck === undefined) return undefined;
      return textEncoder.encode(deck);
    }
    return undefined;
  },
};

registerWorkFormatAdapter(pptxAdapter);

export { pptxAdapter as workPptxAdapter };
