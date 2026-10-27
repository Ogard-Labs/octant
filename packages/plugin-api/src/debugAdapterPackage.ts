import { Schema } from "effect";
import {
  AuthoredPackageManifest,
  isPackageRelativeFile,
  writesHostAssignedField,
} from "./authoredPackageManifest";

/**
 * The public schema for a debug adapter a person adds to Octant themselves.
 * Canonical: docs/design/language-services.md § Component and package.
 *
 * A package holds exactly one `debug-adapter` component: a binary inside the
 * package that speaks the Debug Adapter Protocol on stdio and launches the
 * program being debugged as its own child. The adapter and the program share
 * one capsule confined as the thread's terminal is: they may write the
 * checkout and run programs, and reach only the hosts the thread's network
 * rules allow. A session starts only from a configuration the person
 * confirmed and a Start they pressed at a local window, never in Plan, for a
 * paired device, or for an agent. Install, trust, enablement, and the
 * package's identity, source, digest, and review are facts the host
 * establishes, so the document an author writes cannot carry them, and any
 * field this schema does not name is refused rather than ignored.
 */

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The file at a debug adapter package's root that holds its manifest. A
 * folder that has it is read as a debug adapter package and as nothing else,
 * and a folder that also holds another Octant package document is refused.
 */
export const DEBUG_ADAPTER_PACKAGE_DOCUMENT_PATH = "octant-debug-adapter.json";

/**
 * What a debug adapter may declare: the capsule writes the checkout, runs
 * programs, and reaches the hosts the thread's rules allow, and nothing more.
 * Any other capability names an effect the capsule refuses, so a review that
 * listed it would describe something the adapter can never do.
 */
const ADAPTER_CAPABILITIES: ReadonlySet<string> = new Set(["filesystem", "shell", "network"]);

/**
 * Why a debug adapter package was refused. The set is closed and the host
 * words each reason itself: no text from the package reaches a person.
 *
 * The first group is decided by this schema alone; the second by the host
 * when it reads the package's files.
 */
export const DebugAdapterPackageRefusalReason = Schema.Literal(
  "entry-invalid",
  "host-assigned-field",
  "not-one-debug-adapter",
  "declares-capabilities",
  "declares-contributions",
  "not-for-code",
  "provider-specific",
  "entry-point-not-package-relative",
  "source-unsupported",
  "document-invalid",
  "entry-point-missing",
  "ships-other-program",
);
export type DebugAdapterPackageRefusalReason = typeof DebugAdapterPackageRefusalReason.Type;

const DebugAdapterPackageDocumentShape = Schema.Struct({
  manifest: AuthoredPackageManifest,
}).annotations(strict);
type DebugAdapterPackageDocumentShape = typeof DebugAdapterPackageDocumentShape.Type;

function entryRefusal(
  entry: DebugAdapterPackageDocumentShape,
): DebugAdapterPackageRefusalReason | undefined {
  const { manifest } = entry;
  const [component, ...others] = manifest.components;
  if (
    component === undefined ||
    others.length > 0 ||
    component.kind !== "debug-adapter" ||
    component.debugAdapter === undefined
  ) {
    return "not-one-debug-adapter";
  }
  if (
    manifest.primaryComponentId !== undefined &&
    String(manifest.primaryComponentId) !== String(component.id)
  ) {
    return "not-one-debug-adapter";
  }
  if (
    manifest.declaredCapabilities.some((capability) => !ADAPTER_CAPABILITIES.has(capability)) ||
    component.declaredCapabilities.some((capability) => !ADAPTER_CAPABILITIES.has(capability))
  ) {
    return "declares-capabilities";
  }
  if (manifest.contributions !== undefined && manifest.contributions.length > 0) {
    return "declares-contributions";
  }
  if (manifest.compatibility.modes.some((mode) => mode !== "code")) return "not-for-code";
  // A session runs a person's program in their checkout; no provider is part
  // of that, so a package that names one describes something else.
  if (manifest.compatibility.providerFamilies.length > 0) return "provider-specific";
  if (!isPackageRelativeFile(component.entryPoint ?? "")) {
    return "entry-point-not-package-relative";
  }
  return undefined;
}

/** The document at a debug adapter package's root, as its author writes it. */
export const DebugAdapterPackageDocument = DebugAdapterPackageDocumentShape.pipe(
  Schema.filter((entry) => {
    const reason = entryRefusal(entry);
    return reason === undefined ? true : `A debug adapter package is refused: ${reason}.`;
  }),
);
export type DebugAdapterPackageDocument = typeof DebugAdapterPackageDocument.Type;

export type DebugAdapterPackageDocumentReading =
  | { readonly status: "accepted"; readonly document: DebugAdapterPackageDocument }
  | { readonly status: "refused"; readonly reason: DebugAdapterPackageRefusalReason };

const decodeShape = Schema.decodeUnknownEither(DebugAdapterPackageDocumentShape);

/** Reads a debug adapter package's document, naming the closed reason when it is refused. */
export function readDebugAdapterPackageDocument(
  value: unknown,
): DebugAdapterPackageDocumentReading {
  if (writesHostAssignedField(value)) return { status: "refused", reason: "host-assigned-field" };
  const decoded = decodeShape(value);
  if (decoded._tag === "Left") return { status: "refused", reason: "entry-invalid" };
  const reason = entryRefusal(decoded.right);
  return reason === undefined
    ? { status: "accepted", document: decoded.right }
    : { status: "refused", reason };
}
