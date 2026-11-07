import { Schema } from "effect";
import {
  AuthoredPackageManifest,
  isPackageRelativeFile,
  writesHostAssignedField,
} from "./authoredPackageManifest";

export const CANVAS_EXPORT_PACKAGE_DOCUMENT_PATH = "octant-canvas-export.json";
const shape = Schema.Struct({ manifest: AuthoredPackageManifest }).annotations({
  parseOptions: { onExcessProperty: "error" as const },
});
const decodeShape = Schema.decodeUnknownEither(shape);
export type CanvasExportPackageRefusalReason =
  | "document-invalid"
  | "host-assigned-field"
  | "not-one-export-target"
  | "declares-capabilities"
  | "entry-point-invalid"
  | "source-unsupported"
  | "ships-executable";

/** One bundled JavaScript module; installation runs no package scripts or dependency resolution. */
export function readCanvasExportPackageDocument(
  value: unknown,
):
  | { readonly status: "accepted"; readonly document: typeof shape.Type }
  | { readonly status: "refused"; readonly reason: CanvasExportPackageRefusalReason } {
  if (writesHostAssignedField(value)) return { status: "refused", reason: "host-assigned-field" };
  const decoded = decodeShape(value);
  if (decoded._tag === "Left") return { status: "refused", reason: "document-invalid" };
  const manifest = decoded.right.manifest;
  const [component, ...others] = manifest.components;
  if (
    component?.kind !== "canvas-export-target" ||
    component.canvasExport === undefined ||
    others.length > 0 ||
    (manifest.primaryComponentId !== undefined &&
      String(manifest.primaryComponentId) !== String(component.id)) ||
    (manifest.contributions?.length ?? 0) > 0 ||
    manifest.compatibility.providerFamilies.length > 0
  )
    return { status: "refused", reason: "not-one-export-target" };
  if (
    manifest.declaredCapabilities.some((capability) => capability !== "network") ||
    component.declaredCapabilities.some(
      (capability) =>
        capability !== "network" || !manifest.declaredCapabilities.includes(capability),
    ) ||
    (component.canvasExport.allowedOrigins.length > 0 &&
      !component.declaredCapabilities.includes("network"))
  )
    return { status: "refused", reason: "declares-capabilities" };
  if (
    !isPackageRelativeFile(component.entryPoint ?? "") ||
    !/\.m?js$/.test(component.entryPoint ?? "")
  )
    return { status: "refused", reason: "entry-point-invalid" };
  return { status: "accepted", document: decoded.right };
}
