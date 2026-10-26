import { createHash } from "node:crypto";
import type { ExtensionSource } from "@octant/contracts/extensions";
import {
  LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH,
  readLanguageServerPackageEntry,
  type LanguageServerPackageRefusalReason,
} from "@octant/plugin-api/language-server-package";
import {
  calculateExtensionPackageDigest,
  type ExtensionArchiveEntry,
  type ResolvedExtensionPackage,
} from "./packageInspector";

/**
 * A folder holding a language server a person adds, as the local folder
 * registry read it. `layout` tells it apart from the plugin layouts a folder
 * can have. Canonical: docs/design/language-services.md (user-added `static`
 * servers).
 */
export interface LanguageServerPackageInput {
  readonly layout: "language-server-package";
  readonly source: ExtensionSource;
  readonly format: ResolvedExtensionPackage["format"];
  readonly archiveBytes: number;
  readonly entries: ReadonlyArray<ExtensionArchiveEntry>;
  readonly expectedDigest?: ResolvedExtensionPackage["expectedDigest"];
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
}

export type LanguageServerPackageReading =
  | { readonly status: "accepted"; readonly resolved: ResolvedExtensionPackage }
  | { readonly status: "refused"; readonly reason: LanguageServerPackageRefusalReason };

/**
 * Manifest facts only the host can state: where the package came from, what
 * its content hashes to, the identity it is stored under, and whether anyone
 * reviewed it. An author who writes one is refused rather than overwritten,
 * so the document a person reads is the document the host used.
 */
const HOST_ASSIGNED_MANIFEST_FIELDS = ["extensionId", "packageId", "digest", "source"] as const;
const HOST_ASSIGNED_PROVENANCE_FIELDS = ["reviewed", "reviewedAt"] as const;

/**
 * Reads a local folder as a language server package: its document must be a
 * valid package once the host adds the facts only it can state, its entry
 * point must be an executable file in the package, and no other file may be
 * executable, because the server may run its own binary and nothing else.
 */
export function readLanguageServerPackage(
  input: LanguageServerPackageInput,
): LanguageServerPackageReading {
  // A folder the person picked is the only source until a marketplace
  // package can carry a publisher signature.
  if (input.source.kind !== "local-folder") return refused("source-unsupported");
  const document = parseJsonFile(input.entries, LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH);
  if (!isRecord(document) || !isRecord(document.manifest)) return refused("document-invalid");
  const authored = document.manifest;
  const authoredProvenance = isRecord(authored.provenance) ? authored.provenance : {};
  if (
    HOST_ASSIGNED_MANIFEST_FIELDS.some((field) => field in authored) ||
    HOST_ASSIGNED_PROVENANCE_FIELDS.some((field) => field in authoredProvenance)
  ) {
    return refused("host-assigned-field");
  }
  const slug = typeof authored.slug === "string" ? authored.slug : "";
  const manifest = {
    ...authored,
    extensionId: stableUuid(`extension:${input.source.sourceRef}:${slug}`),
    packageId: stableUuid(`package:${input.source.sourceRef}:${slug}`),
    digest: `sha256:${"0".repeat(64)}`,
    source: input.source,
    provenance: { ...authoredProvenance, reviewed: false },
  };
  const reading = readLanguageServerPackageEntry({ ...document, manifest });
  if (reading.status === "refused") return reading;
  const filesRefusal = packageFilesRefusal(
    input.entries,
    reading.entry.manifest.components[0]?.entryPoint,
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
export class LanguageServerPackageRefusedError extends Error {
  override readonly name = "LanguageServerPackageRefusedError";

  constructor(readonly reason: LanguageServerPackageRefusalReason) {
    super(languageServerPackageRefusalMessage(reason));
  }
}

/** Octant's own words for each refusal; nothing from the package is repeated. */
export function languageServerPackageRefusalMessage(
  reason: LanguageServerPackageRefusalReason,
): string {
  switch (reason) {
    case "entry-invalid":
      return "This language server's description is not one Octant can read.";
    case "document-invalid":
      return "This language server's description file is missing or is not valid JSON.";
    case "host-assigned-field":
      return "This language server states its own identity, source, digest or review; Octant sets those itself.";
    case "bundled-source":
      return "A language server you add cannot say it is bundled with Octant.";
    case "bundled-claim":
      return "This language server claims the name or binary of the one bundled with Octant.";
    case "not-one-language-server":
      return "A language server package holds exactly one language server and nothing else.";
    case "launch-class-unsupported":
      return "Octant runs only language servers that read the checkout without running its tools.";
    case "declares-capabilities":
      return "A language server you add may only read files; it cannot ask for the shell, the network or credentials.";
    case "declares-contributions":
      return "A language server adds nothing to Octant's windows.";
    case "not-for-code":
      return "A language server serves Code threads only.";
    case "provider-specific":
      return "A language server serves the editor, not a model provider.";
    case "entry-point-not-package-relative":
      return "A language server's binary must be a file inside its package.";
    case "source-unsupported":
      return "Language servers can be added only from a folder on this computer.";
    case "entry-point-missing":
      return "This language server's binary is not in its package, or is not executable.";
    case "ships-other-program":
      return "This language server ships a program besides its own binary; it may run its binary and nothing else.";
  }
}

function packageFilesRefusal(
  entries: ReadonlyArray<ExtensionArchiveEntry>,
  entryPoint: string | undefined,
): LanguageServerPackageRefusalReason | undefined {
  const files = entries.filter((entry) => entry.kind === "file");
  const binary = files.find((entry) => entry.path === entryPoint);
  if (entryPoint === undefined || binary?.executable !== true) return "entry-point-missing";
  if (files.some((entry) => entry.executable === true && entry.path !== entryPoint)) {
    return "ships-other-program";
  }
  return undefined;
}

function parseJsonFile(entries: ReadonlyArray<ExtensionArchiveEntry>, path: string): unknown {
  const entry = entries.find((candidate) => candidate.path === path && candidate.kind === "file");
  if (entry?.content === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.content)) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refused(reason: LanguageServerPackageRefusalReason): LanguageServerPackageReading {
  return { status: "refused", reason };
}

/**
 * The stored identity of a folder's server, derived from the folder and the
 * slug so a new version from the same folder updates the same package, and a
 * package can never name itself into another one's identity, the bundled
 * server's included.
 */
function stableUuid(seed: string): string {
  const bytes = createHash("sha256")
    .update(`octant.language-server-package\0${seed}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
