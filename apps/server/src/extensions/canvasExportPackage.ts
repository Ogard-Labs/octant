import type { ExtensionSource } from "@octant/contracts/extensions";
import {
  CANVAS_EXPORT_PACKAGE_DOCUMENT_PATH,
  readCanvasExportPackageDocument,
  type CanvasExportPackageRefusalReason,
} from "@octant/plugin-api/canvas-export-package";
import { hostStatedManifest, isRecord, parsePackageDocumentFile } from "./languageServerPackage";
import {
  calculateExtensionPackageDigest,
  type ExtensionArchiveEntry,
  type ResolvedExtensionPackage,
} from "./packageInspector";
import { readPackagePublisherSignature } from "./outsideDriverSignature";

export interface CanvasExportPackageInput {
  readonly layout: "canvas-export-package";
  readonly source: ExtensionSource;
  readonly format: ResolvedExtensionPackage["format"];
  readonly archiveBytes: number;
  readonly entries: ReadonlyArray<ExtensionArchiveEntry>;
  readonly expectedDigest?: ResolvedExtensionPackage["expectedDigest"];
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
}

export function readCanvasExportPackage(
  input: CanvasExportPackageInput,
):
  | { readonly status: "accepted"; readonly resolved: ResolvedExtensionPackage }
  | { readonly status: "refused"; readonly reason: CanvasExportPackageRefusalReason } {
  if (input.source.kind !== "local-folder")
    return { status: "refused", reason: "source-unsupported" };
  const document = parsePackageDocumentFile(input.entries, CANVAS_EXPORT_PACKAGE_DOCUMENT_PATH);
  const reading = readCanvasExportPackageDocument(document);
  if (reading.status === "refused") return reading;
  if (!isRecord(document) || !isRecord(document.manifest))
    return { status: "refused", reason: "document-invalid" };
  const entryPoint = reading.document.manifest.components[0]?.entryPoint;
  if (!input.entries.some((entry) => entry.kind === "file" && entry.path === entryPoint))
    return { status: "refused", reason: "entry-point-invalid" };
  if (input.entries.some((entry) => entry.executable === true))
    return { status: "refused", reason: "ships-executable" };
  const signature = readPackagePublisherSignature(input.entries, {
    name: reading.document.manifest.slug,
    version: reading.document.manifest.version,
  });
  if (signature.status === "invalid") return { status: "refused", reason: "signature-invalid" };
  const manifest = hostStatedManifest(
    "octant.canvas-export-package",
    input.source,
    document.manifest,
    reading.document.manifest.slug,
    signature.status === "signed" ? signature.publisherKey : undefined,
  );
  const digest = calculateExtensionPackageDigest(manifest, input.entries);
  return {
    status: "accepted",
    resolved: {
      format: input.format,
      archiveBytes: input.archiveBytes,
      manifest: { ...manifest, digest },
      entries: input.entries,
      expectedDigest: input.expectedDigest ?? digest,
      appVersion: input.appVersion,
      platform: input.platform,
    },
  };
}
