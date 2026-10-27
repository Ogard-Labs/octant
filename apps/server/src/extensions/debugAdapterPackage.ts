import type { ExtensionSource } from "@octant/contracts/extensions";
import {
  DEBUG_ADAPTER_PACKAGE_DOCUMENT_PATH,
  readDebugAdapterPackageDocument,
  type DebugAdapterPackageRefusalReason,
} from "@octant/plugin-api/debug-adapter-package";
import {
  binaryOnlyFilesRefusal,
  hostStatedManifest,
  isRecord,
  parsePackageDocumentFile,
} from "./languageServerPackage";
import {
  calculateExtensionPackageDigest,
  type ExtensionArchiveEntry,
  type ResolvedExtensionPackage,
} from "./packageInspector";

/**
 * A folder holding a debug adapter a person adds, as the local folder
 * registry read it. Canonical: docs/design/language-services.md § Component
 * and package.
 */
export interface DebugAdapterPackageInput {
  readonly layout: "debug-adapter-package";
  readonly source: ExtensionSource;
  readonly format: ResolvedExtensionPackage["format"];
  readonly archiveBytes: number;
  readonly entries: ReadonlyArray<ExtensionArchiveEntry>;
  readonly expectedDigest?: ResolvedExtensionPackage["expectedDigest"];
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
}

export type DebugAdapterPackageReading =
  | { readonly status: "accepted"; readonly resolved: ResolvedExtensionPackage }
  | { readonly status: "refused"; readonly reason: DebugAdapterPackageRefusalReason };

/**
 * Reads a local folder as a debug adapter package, as a user-added language
 * server is read: its document must be one the public schema accepts, its
 * entry point an executable file in the package, and no other file
 * executable. The adapter may still run programs the capsule can see, such
 * as a runtime on the system path, because the program it debugs needs them;
 * its package brings no other program.
 */
export function readDebugAdapterPackage(
  input: DebugAdapterPackageInput,
): DebugAdapterPackageReading {
  // A folder the person picked is the only source until a marketplace
  // package can carry a publisher signature.
  if (input.source.kind !== "local-folder") return refused("source-unsupported");
  const document = parsePackageDocumentFile(input.entries, DEBUG_ADAPTER_PACKAGE_DOCUMENT_PATH);
  if (!isRecord(document) || !isRecord(document.manifest)) return refused("document-invalid");
  const reading = readDebugAdapterPackageDocument(document);
  if (reading.status === "refused") return reading;
  const manifest = hostStatedManifest(
    "octant.debug-adapter-package",
    input.source,
    document.manifest,
    reading.document.manifest.slug,
  );
  const filesRefusal = binaryOnlyFilesRefusal(
    input.entries,
    reading.document.manifest.components[0]?.entryPoint,
  );
  if (filesRefusal !== undefined) return refused(filesRefusal);
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

/**
 * Raised at the package-resolver boundary, which reports failure by throwing,
 * so the extension API can answer with the closed reason's own words.
 */
export class DebugAdapterPackageRefusedError extends Error {
  override readonly name = "DebugAdapterPackageRefusedError";

  constructor(readonly reason: DebugAdapterPackageRefusalReason) {
    super(debugAdapterPackageRefusalMessage(reason));
  }
}

/** Octant's own words for each refusal; nothing from the package is repeated. */
export function debugAdapterPackageRefusalMessage(
  reason: DebugAdapterPackageRefusalReason,
): string {
  switch (reason) {
    case "entry-invalid":
      return "This debug adapter's description is not one Octant can read.";
    case "document-invalid":
      return "This debug adapter's description file is missing or is not valid JSON.";
    case "host-assigned-field":
      return "This debug adapter states its own identity, source, digest or review; Octant sets those itself.";
    case "not-one-debug-adapter":
      return "A debug adapter package holds exactly one debug adapter and nothing else.";
    case "declares-capabilities":
      return "A debug adapter may only use files, the shell, and the network, as a terminal can; it cannot ask for credentials or anything else.";
    case "declares-contributions":
      return "A debug adapter adds nothing to Octant's windows.";
    case "not-for-code":
      return "A debug adapter serves Code threads only.";
    case "provider-specific":
      return "A debug adapter runs your program, not a model provider.";
    case "entry-point-not-package-relative":
      return "A debug adapter's binary must be a file inside its package.";
    case "source-unsupported":
      return "Debug adapters can be added only from a folder on this computer.";
    case "entry-point-missing":
      return "This debug adapter's binary is not in its package, or is not executable.";
    case "ships-other-program":
      return "This debug adapter ships a program besides its own binary.";
  }
}

function refused(reason: DebugAdapterPackageRefusalReason): DebugAdapterPackageReading {
  return { status: "refused", reason };
}
