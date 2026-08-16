import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Schema } from "effect";
import { ProjectId, UtcTimestamp } from "@octant/contracts";
import {
  PreviewCapabilityFlags,
  decodePreviewManifest,
  decodePreviewTarget,
  type PreviewContentBounds,
  type PreviewHostId,
  type PreviewKind,
  type PreviewManifest,
} from "@octant/contracts/previews";
import { computePreviewSourceVersionFromBytes } from "./previewSourceVersion";
import { sniffPreviewKind } from "./previewSniffer";
import { resolveConfinedPath, type PreviewTargetRecord } from "./previewTargetRegistry";
import { computeTableBounds, inferTableDelimiter } from "./previewTableChunker";
import { computeWorkbookBounds } from "./previewWorkbookChunker";
import { computeDocumentBounds } from "./previewDocumentChunker";
import { computeSlidesBounds } from "./previewSlidesChunker";
import { computePdfBounds } from "./previewPdfChunker";

export interface PreviewBudget {
  readonly maxSniffBytes: number;
  readonly maxByteSize: number;
  readonly maxRenderBytes: number;
}

export type PreviewManifestResult =
  | { readonly ok: true; readonly manifest: PreviewManifest }
  | { readonly ok: false; readonly code: "unavailable" }
  | {
      readonly ok: false;
      readonly code: "too-large";
      readonly byteSize: number;
      readonly limit: number;
    }
  | { readonly ok: false; readonly code: "containment-violation" };

export interface ProducePreviewManifestInput {
  readonly projectRoot: string;
  readonly hostId: PreviewHostId;
  readonly projectId: ProjectId;
  readonly record: PreviewTargetRecord;
  readonly budget: PreviewBudget;
}

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/**
 * Produce a sanitized `PreviewManifest` for a resolved preview target.
 * Reads the file once under the byte-size budget, sniffs the normalized
 * kind from content, computes the content-addressed source version, and
 * derives fidelity + capabilities + bounds. The manifest is decoded
 * through the contract so any contract violation surfaces here rather
 * than reaching the renderer.
 */
export function producePreviewManifest(input: ProducePreviewManifestInput): PreviewManifestResult {
  const { projectRoot, hostId, projectId, record, budget } = input;
  const target = decodePreviewTarget({
    targetId: record.targetId,
    projectId,
    hostId,
    kind: record.kind,
    opaqueRef: record.opaqueRef,
    displayName: basename(record.relativePath),
  });

  // P1: resolve the confined canonical path BEFORE any filesystem side
  // effect. A symlink or traversal that escapes the root must surface as
  // containment-violation without reading a single byte of the target.
  const confined = resolveConfinedPath(projectRoot, record.relativePath);
  if (!confined.ok) return confined;

  // P2: stat before read so a file exceeding the byte-size budget is
  // rejected without materializing its full content in memory.
  let size: number;
  try {
    size = statSync(confined.absolutePath).size;
  } catch {
    return { ok: false, code: "unavailable" };
  }
  if (size > budget.maxByteSize) {
    return { ok: false, code: "too-large", byteSize: size, limit: budget.maxByteSize };
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(confined.absolutePath);
  } catch {
    return { ok: false, code: "unavailable" };
  }

  // P2: supply a non-empty declared media type so the unsupported branch
  // never produces an empty sniffedMediaType that decodePreviewManifest
  // would reject.
  const sniffed = sniffPreviewKind(bytes, record.relativePath, "application/octet-stream", {
    maxSniffBytes: budget.maxSniffBytes,
    maxByteSize: budget.maxByteSize,
  });
  if (!sniffed.ok) {
    // The sniffer's too-large is redundant with the stat-based check above,
    // but the typed result still requires byte size and limit when it fires.
    return { ok: false, code: "too-large", byteSize: bytes.byteLength, limit: budget.maxByteSize };
  }

  const sourceVersion = computePreviewSourceVersionFromBytes(bytes);
  const limited = bytes.byteLength > budget.maxRenderBytes;
  const fidelity = fidelityFor(sniffed.kind, limited);
  const bounds = boundsFor(sniffed.kind, bytes, sniffed.mediaType);

  const manifest = decodePreviewManifest({
    target,
    sourceVersion,
    kind: sniffed.kind,
    sniffedMediaType: sniffed.mediaType,
    byteSize: bytes.byteLength,
    fidelity,
    capabilities: capabilitiesFor(sniffed.kind),
    bounds,
    producedAt: decodeTimestamp(new Date().toISOString()),
  });

  return { ok: true, manifest };
}

/**
 * Fidelity classification per preview kind. Office formats (workbook,
 * document, slides) and PDF are inherently limited-fidelity: their V1
 * viewers extract structural text and stored values without executing
 * formulas, macros, active content, or rendering pixel-perfect layout, so
 * a visible fidelity notice is always emitted. Text, Markdown, image, and
 * table previews are full-fidelity when under the render budget and
 * limited only when the render budget truncates them.
 */
function fidelityFor(
  kind: PreviewKind,
  limited: boolean,
): { level: "full" | "limited"; notice?: string } {
  switch (kind) {
    case "pdf":
      return {
        level: "limited",
        notice:
          "Text extraction only. Rendered page images, forms, scripts, and active content are disabled.",
      };
    case "workbook":
      return {
        level: "limited",
        notice:
          "Stored cell values and cached formula results only. Formula execution, macros, charts, and embedded objects are disabled.",
      };
    case "document":
      return {
        level: "limited",
        notice:
          "Structural text view. Complex layout, fonts, fields, comments, and tracked changes may require external handoff.",
      };
    case "slides":
      return {
        level: "limited",
        notice:
          "Slide text only. Transitions, media playback, embedded objects, and pixel-perfect layout are not guaranteed.",
      };
    case "text":
    case "markdown":
    case "image":
    case "table":
      return limited
        ? { level: "limited", notice: "Render budget exceeded; showing a bounded preview." }
        : { level: "full" };
    case "unsupported":
    default:
      return limited
        ? { level: "limited", notice: "Render budget exceeded; showing a bounded preview." }
        : { level: "full" };
  }
}

/**
 * Compute manifest bounds for bounded formats by parsing the source
 * bytes. Text, Markdown, image, and unsupported kinds start with empty
 * bounds (their parsers populate state as they stream). PDF, table,
 * workbook, document, and slides bounds are computed here so the viewer
 * can render navigation (page/sheet/slide counts) immediately. A
 * malformed bounded source produces empty bounds; the chunker yields no
 * chunks and the viewer surfaces a failed state.
 */
function boundsFor(kind: PreviewKind, bytes: Uint8Array, mediaType: string): PreviewContentBounds {
  switch (kind) {
    case "pdf":
      return computePdfBounds(bytes);
    case "table":
      return computeTableBounds(bytes, delimiterForTable(mediaType, bytes));
    case "workbook":
      return computeWorkbookBounds(bytes);
    case "document":
      return computeDocumentBounds(bytes);
    case "slides":
      return computeSlidesBounds(bytes);
    default:
      return {};
  }
}

/**
 * Resolve the delimiter for a table source from the sniffed media type,
 * falling back to content inference. Returns `,` when no delimiter can be
 * inferred so the chunker always receives a valid `PreviewDelimiter`.
 */
function delimiterForTable(mediaType: string, bytes: Uint8Array): "," | "\t" | ";" | "|" {
  if (mediaType === "text/tab-separated-values") return "\t";
  if (mediaType === "text/csv") return ",";
  const inferred = inferTableDelimiter(Buffer.from(bytes).toString("utf-8"));
  return inferred ?? ",";
}

function capabilitiesFor(kind: PreviewKind): PreviewCapabilityFlags {
  switch (kind) {
    case "text":
    case "markdown":
      return {
        canSearch: true,
        canSelect: true,
        canZoom: false,
        canRevealInFinder: true,
        canOpenExternally: true,
        canQuickLook: true,
        canEditInMonaco: true,
      };
    case "image":
      return {
        canSearch: false,
        canSelect: true,
        canZoom: true,
        canRevealInFinder: true,
        canOpenExternally: true,
        canQuickLook: true,
        canEditInMonaco: false,
      };
    case "pdf":
      return {
        canSearch: true,
        canSelect: true,
        canZoom: true,
        canRevealInFinder: true,
        canOpenExternally: true,
        canQuickLook: true,
        canEditInMonaco: false,
      };
    case "table":
      return {
        canSearch: true,
        canSelect: true,
        canZoom: false,
        canRevealInFinder: true,
        canOpenExternally: true,
        canQuickLook: true,
        canEditInMonaco: false,
      };
    case "workbook":
      return {
        canSearch: true,
        canSelect: true,
        canZoom: false,
        canRevealInFinder: true,
        canOpenExternally: true,
        canQuickLook: true,
        canEditInMonaco: false,
      };
    case "document":
      return {
        canSearch: true,
        canSelect: true,
        canZoom: false,
        canRevealInFinder: true,
        canOpenExternally: true,
        canQuickLook: true,
        canEditInMonaco: false,
      };
    case "slides":
      return {
        canSearch: true,
        canSelect: true,
        canZoom: true,
        canRevealInFinder: true,
        canOpenExternally: true,
        canQuickLook: true,
        canEditInMonaco: false,
      };
    case "unsupported":
    default:
      return {
        canSearch: false,
        canSelect: false,
        canZoom: false,
        canRevealInFinder: true,
        canOpenExternally: true,
        canQuickLook: true,
        canEditInMonaco: false,
      };
  }
}
