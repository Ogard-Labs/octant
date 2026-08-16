import type { WorkArtifactFormat, WorkCapabilityFlags } from "@octant/contracts/work-artifacts";

/**
 * Format adapter contract for Work artifact production. Slice B's generic
 * text adapter handles UTF-8 text formats (markdown, csv, markdown-deck).
 * Slices C-F register format-specific adapters for binary formats
 * (docx, xlsx, pptx, pdf, image) that materialize real, valid file bytes from
 * renderer-supplied text content and convert between formats for transform and
 * export. The mutation service resolves an adapter per format and fails closed
 * as `unsupported` when no adapter exists or a requested conversion is not
 * supported. Adapters never perform filesystem, network, or authority work;
 * they are pure byte transforms the mutation service invokes after the
 * confinement authority check passes.
 */
export interface WorkFormatAdapter {
  readonly format: WorkArtifactFormat;
  /**
   * Encode renderer-supplied text content into file bytes for create and
   * revise. The renderer sends normalized UTF-8 text; the adapter
   * materializes the format-specific binary (or text) representation.
   */
  encode(content: string): Uint8Array;
  /**
   * Decode file bytes back into renderer text content for round-trip read.
   * Returns `undefined` when the format cannot safely round-trip into the
   * normalized text representation; the renderer then offers an explicit
   * derived/export format instead of pretending a lossy round-trip is safe.
   */
  decode(bytes: Uint8Array): string | undefined;
  /** Honest capability flags for this format. Never grant authority. */
  readonly capabilities: WorkCapabilityFlags;
  /**
   * Derived export formats available when safe round-tripping is unavailable.
   * The capability report exposes these so the renderer can present an
   * explicit export-only fallback. Same-format round-trip is governed by
   * `capabilities.canRoundTrip`, not this list.
   */
  readonly exportFormats: readonly WorkArtifactFormat[];
  /**
   * Convert source bytes into target-format bytes for transform and export.
   * Returns `undefined` when the conversion is not supported so the mutation
   * service fails closed as `unsupported`. Same-format conversion is supported
   * when `capabilities.canRoundTrip` is true and returns the source bytes
   * unchanged for text formats or a re-encoded round-trip for binary formats.
   */
  convertTo(targetFormat: WorkArtifactFormat, sourceBytes: Uint8Array): Uint8Array | undefined;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Build a UTF-8 text adapter for a text format. Text formats encode content as
 * UTF-8, decode bytes back as UTF-8, round-trip fully, and support same-format
 * conversion only; cross-format transform/export fails closed as unsupported
 * because the capability report advertises no derived export formats for text.
 */
function textAdapter(format: WorkArtifactFormat): WorkFormatAdapter {
  return {
    format,
    encode: (content) => textEncoder.encode(content),
    decode: (bytes) => {
      try {
        return textDecoder.decode(bytes);
      } catch {
        return undefined;
      }
    },
    capabilities: {
      canRead: true,
      canCreate: true,
      canMutate: true,
      canRoundTrip: true,
      canExport: true,
      canVersion: true,
    },
    exportFormats: [],
    convertTo: (targetFormat, sourceBytes) => (targetFormat === format ? sourceBytes : undefined),
  };
}

/** Text-format adapters registered by the slice B foundation. */
const TEXT_ADAPTERS: ReadonlyArray<WorkFormatAdapter> = (
  ["markdown", "csv", "markdown-deck"] as const
).map(textAdapter);

const adapterRegistry = new Map<WorkArtifactFormat, WorkFormatAdapter>(
  TEXT_ADAPTERS.map((adapter) => [adapter.format, adapter]),
);

/**
 * Register a format-specific adapter. Slice C-F adapters call this once at
 * module load to add binary format support. Re-registering an existing format
 * replaces the adapter so tests can override behavior deterministically.
 */
export function registerWorkFormatAdapter(adapter: WorkFormatAdapter): void {
  adapterRegistry.set(adapter.format, adapter);
}

/**
 * Resolve the adapter for a Work format. Returns `undefined` when no adapter
 * is registered; the mutation service fails closed as `unsupported` for that
 * format.
 */
export function getWorkFormatAdapter(format: WorkArtifactFormat): WorkFormatAdapter | undefined {
  return adapterRegistry.get(format);
}

/**
 * Typed error thrown by an adapter when its own preflight or accumulated-output
 * budget check rejects work. The mutation service catch distinguishes this from
 * a true parse failure so the reply preserves the `oversize` failure code
 * instead of collapsing it into `parse-failed`.
 */
export class WorkAdapterBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkAdapterBudgetError";
  }
}
/**
 * Typed rejection for content that a format cannot encode without silent
 * loss. The mutation service maps this to an honest unsupported outcome.
 */
export class WorkAdapterUnsupportedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkAdapterUnsupportedInputError";
  }
}
