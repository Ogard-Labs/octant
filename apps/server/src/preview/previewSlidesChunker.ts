import { readFileSync } from "node:fs";
import { Schema } from "effect";
import {
  PreviewChunkSequence,
  decodePreviewChunk,
  type PreviewChunk,
  type PreviewChunkId,
  type PreviewContentBounds,
  type PreviewSourceVersion,
  type PreviewTargetId,
} from "@octant/contracts/previews";
import { readWorkZip } from "../work/workZipPort";
import {
  computePreviewSourceVersionFromBytes,
  samePreviewSourceVersion,
} from "./previewSourceVersion";
import { MAX_PREVIEW_CHUNK_TEXT_BYTES, MAX_PREVIEW_SLIDES } from "./previewFormatBudget";

const decodeSequence = Schema.decodeUnknownSync(PreviewChunkSequence);
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export interface SlidesChunkBudget {
  readonly maxSlides: number;
  readonly maxSlideTextBytes: number;
  readonly maxRenderBytes?: number;
}

export interface ProduceSlidesChunksInput {
  readonly filePath: string;
  readonly targetId: PreviewTargetId;
  readonly chunkId: PreviewChunkId;
  readonly sourceVersion: PreviewSourceVersion;
  readonly budget: SlidesChunkBudget;
}

export interface ParsedSlides {
  /** Slide text (title + body bullets joined with newlines) in order. */
  readonly slides: readonly string[];
  readonly truncated: boolean;
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
 * Extract paragraph text from a slide shape's XML fragment. Collects all
 * `<a:t>...</a:t>` contents in document order and joins them per
 * paragraph with newlines.
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

/**
 * Parse a slide's XML into title and body bullet text. Splits the shape
 * tree into `<p:sp>` shapes, classifies each by its placeholder type, and
 * extracts text runs. Returns empty content when no title/body
 * placeholder is found.
 */
function parseSlideXml(xml: string): {
  readonly title: string;
  readonly bullets: readonly string[];
} {
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
    } else if (phType === undefined) {
      // Shapes without a placeholder (e.g. text boxes) still contribute
      // body text so slide content is not silently dropped.
      for (const text of texts) bullets.push(text);
    }
  }
  return { title, bullets };
}

/**
 * Resolve the ordered list of slide part paths from the presentation XML
 * and its rels. Falls back to filename-sort ordering of
 * `ppt/slides/slideN.xml` parts when the presentation or rels part is
 * missing.
 */
function resolveSlideOrder(entries: Map<string, Uint8Array>): string[] | undefined {
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
    paths.push(target.startsWith("ppt/") ? target : `ppt/${target}`);
  }
  return paths;
}

/**
 * Parse a PPTX byte container into ordered slide text. Slide-level text
 * (title + body bullets) is extracted; transitions, media playback,
 * themes, and pixel-perfect layout are not preserved. A malformed
 * container returns `undefined`.
 */
export function parseSlides(
  bytes: Uint8Array,
  budget: Pick<SlidesChunkBudget, "maxSlides" | "maxSlideTextBytes">,
): ParsedSlides | undefined {
  let entries: Map<string, Uint8Array>;
  try {
    entries = readWorkZip(bytes);
  } catch {
    return undefined;
  }
  const orderedPaths = resolveSlideOrder(entries);
  let slideXmls: string[];
  if (orderedPaths !== undefined && orderedPaths.length > 0) {
    slideXmls = [];
    for (const path of orderedPaths) {
      const data = entries.get(path);
      if (data === undefined) return undefined;
      slideXmls.push(textDecoder.decode(data));
    }
  } else {
    const slidePattern = /^ppt\/slides\/slide(\d+)\.xml$/;
    const found: Array<{ index: number; xml: string }> = [];
    for (const [name, data] of entries) {
      const match = slidePattern.exec(name);
      if (match)
        found.push({ index: Number.parseInt(match[1] ?? "0", 10), xml: textDecoder.decode(data) });
    }
    if (found.length === 0) return undefined;
    found.sort((a, b) => a.index - b.index);
    slideXmls = found.map((entry) => entry.xml);
  }
  const slides: string[] = [];
  let truncated = false;
  for (const xml of slideXmls) {
    if (slides.length >= budget.maxSlides) {
      truncated = true;
      break;
    }
    const slide = parseSlideXml(xml);
    const lines: string[] = [];
    if (slide.title !== "") lines.push(slide.title);
    for (const bullet of slide.bullets) lines.push(bullet);
    const text = lines.join("\n");
    if (Buffer.byteLength(text, "utf-8") > budget.maxSlideTextBytes) {
      slides.push(sliceUtf8AtByteBudget(text, budget.maxSlideTextBytes));
      truncated = true;
    } else {
      slides.push(text);
    }
  }
  return { slides, truncated };
}

/**
 * Compute manifest bounds for a PPTX source: the slide count (capped at
 * the budget ceiling). Returns empty bounds when the container is
 * malformed.
 */
export function computeSlidesBounds(bytes: Uint8Array): PreviewContentBounds {
  const parsed = parseSlides(bytes, {
    maxSlides: MAX_PREVIEW_SLIDES,
    maxSlideTextBytes: MAX_PREVIEW_CHUNK_TEXT_BYTES,
  });
  if (parsed === undefined) return {};
  return { slides: parsed.slides.length };
}

/**
 * Produce bounded slides (PPTX) preview chunks. Each slide becomes one
 * chunk carrying its 1-based slide number and extracted text. The
 * generator recomputes the source version from the bytes it reads and
 * aborts when the file changed since the caller recorded the version. A
 * missing or malformed file yields no chunks.
 */
export function* produceSlidesChunks(input: ProduceSlidesChunksInput): Generator<PreviewChunk> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(input.filePath);
  } catch {
    return;
  }

  const current = computePreviewSourceVersionFromBytes(bytes);
  if (!samePreviewSourceVersion(current, input.sourceVersion)) return;

  const parsed = parseSlides(bytes, {
    maxSlides: input.budget.maxSlides,
    maxSlideTextBytes: input.budget.maxSlideTextBytes,
  });
  if (parsed === undefined) return;

  const renderCap = input.budget.maxRenderBytes;
  let renderedBytes = 0;
  let sequence = 0;
  for (let slideIndex = 0; slideIndex < parsed.slides.length; slideIndex += 1) {
    const slideText = parsed.slides[slideIndex];
    if (slideText === undefined) continue;
    const slideNumber = slideIndex + 1;
    const slideBytes = Buffer.byteLength(slideText, "utf-8");
    if (renderCap !== undefined && renderedBytes + slideBytes > renderCap) {
      const chunk = decodePreviewChunk({
        chunkId: input.chunkId,
        targetId: input.targetId,
        sourceVersion: input.sourceVersion,
        kind: "slides",
        sequence: decodeSequence(sequence),
        descriptor: { kind: "slides", slide: slideNumber },
        payload: { kind: "slides", slideText: "" },
        isFinal: true,
      });
      yield chunk;
      return;
    }
    renderedBytes += slideBytes;
    const isFinal = slideIndex === parsed.slides.length - 1 && !parsed.truncated;
    const chunk = decodePreviewChunk({
      chunkId: input.chunkId,
      targetId: input.targetId,
      sourceVersion: input.sourceVersion,
      kind: "slides",
      sequence: decodeSequence(sequence),
      descriptor: { kind: "slides", slide: slideNumber },
      payload: { kind: "slides", slideText },
      isFinal,
    });
    yield chunk;
    sequence += 1;
  }
}

function sliceUtf8AtByteBudget(text: string, budget: number): string {
  let total = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === undefined) break;
    const charBytes = Buffer.byteLength(char, "utf-8");
    if (total + charBytes > budget) break;
    total += charBytes;
    i += 1;
  }
  return text.slice(0, i);
}

export const DEFAULT_SLIDES_BUDGET: SlidesChunkBudget = {
  maxSlides: MAX_PREVIEW_SLIDES,
  maxSlideTextBytes: MAX_PREVIEW_CHUNK_TEXT_BYTES,
};
