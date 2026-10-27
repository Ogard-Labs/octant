import { Schema } from "effect";
import { ExtensionPackageManifest, ExtensionProvenance } from "@octant/contracts/extensions";

/**
 * The manifest an author writes for a package a person adds from a local
 * folder: a package manifest without the facts only the host states. Shared
 * by the language server and debug adapter package documents, which differ
 * only in the one component each holds.
 */

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Manifest facts only the host states: the identity it stores the package
 * under, where it came from, what its content hashes to, and whether anyone
 * reviewed it. An author who writes one is refused rather than overwritten,
 * so the document a person reads is the document the host used.
 */
const HOST_ASSIGNED_MANIFEST_FIELDS = ["extensionId", "packageId", "digest", "source"] as const;
const HOST_ASSIGNED_PROVENANCE_FIELDS = ["reviewed", "reviewedAt"] as const;

const {
  extensionId: _extensionId,
  packageId: _packageId,
  digest: _digest,
  source: _source,
  provenance: _provenance,
  ...authoredManifestFields
} = ExtensionPackageManifest.from.fields;
const {
  reviewed: _reviewed,
  reviewedAt: _reviewedAt,
  ...authoredProvenanceFields
} = ExtensionProvenance.fields;

/** The manifest an author writes: a package manifest without the host's facts. */
export const AuthoredPackageManifest = Schema.Struct({
  ...authoredManifestFields,
  provenance: Schema.optional(Schema.Struct(authoredProvenanceFields).annotations(strict)),
}).annotations(strict);

/** Whether a package document's manifest states a fact only the host may state. */
export function writesHostAssignedField(document: unknown): boolean {
  if (!isRecord(document) || !isRecord(document.manifest)) return false;
  const authored = document.manifest;
  const provenance = isRecord(authored.provenance) ? authored.provenance : {};
  return (
    HOST_ASSIGNED_MANIFEST_FIELDS.some((field) => Object.hasOwn(authored, field)) ||
    HOST_ASSIGNED_PROVENANCE_FIELDS.some((field) => Object.hasOwn(provenance, field))
  );
}

/**
 * An entry point is a file inside the package: relative, with no scheme (so
 * no `builtin:` program and no `file:` reach), and no empty, `.`, or `..`
 * segment.
 */
export function isPackageRelativeFile(entryPoint: string): boolean {
  if (entryPoint.includes(":") || entryPoint.includes("\\") || entryPoint.startsWith("/")) {
    return false;
  }
  return entryPoint.split("/").every((segment) => segment !== "" && !/^\.+$/.test(segment));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
