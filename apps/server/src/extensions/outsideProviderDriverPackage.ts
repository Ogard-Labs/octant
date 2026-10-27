import { createHash } from "node:crypto";
import type { ExtensionSource } from "@octant/contracts/extensions";
import {
  OUTSIDE_PROVIDER_DRIVER_DOCUMENT_PATH,
  readOutsideProviderDriverEntry,
  type OutsideProviderDriverRefusalReason,
} from "@octant/plugin-api/outside-provider-driver";
import {
  calculateExtensionPackageDigest,
  type ExtensionArchiveEntry,
  type ResolvedExtensionPackage,
} from "./packageInspector";

/**
 * A folder holding an outside provider driver, as the local folder registry
 * read it. `layout` tells it apart from the plugin layouts a folder can have.
 */
export interface OutsideProviderDriverPackageInput {
  readonly layout: "outside-provider-driver";
  readonly source: ExtensionSource;
  readonly format: ResolvedExtensionPackage["format"];
  readonly archiveBytes: number;
  readonly entries: ReadonlyArray<ExtensionArchiveEntry>;
  readonly expectedDigest?: ResolvedExtensionPackage["expectedDigest"];
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
}

export type OutsideProviderDriverPackageReading =
  | { readonly status: "accepted"; readonly resolved: ResolvedExtensionPackage }
  | { readonly status: "refused"; readonly reason: OutsideProviderDriverRefusalReason };

/**
 * The harness endpoint protocol versions this host speaks. A package that
 * declares none of them could never complete its handshake, so it is refused
 * at inspection rather than installed to fail later.
 */
const HOST_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set(["harness-endpoint/1"]);

/**
 * Manifest facts only the host can state: where the package came from, what
 * its content hashes to, the identity it is stored under, and whether anyone
 * reviewed it. An author who writes one is refused rather than overwritten,
 * so the document a person reads is the document the host used.
 */
const HOST_ASSIGNED_MANIFEST_FIELDS = ["extensionId", "packageId", "digest", "source"] as const;
const HOST_ASSIGNED_PROVENANCE_FIELDS = ["reviewed", "reviewedAt"] as const;

/**
 * npm lifecycle scripts that run when a package or its dependents are
 * installed. `prepublish` is deprecated but npm still runs it on a plain
 * `npm install`.
 */
const INSTALL_LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
] as const;

/**
 * Reads a local folder as an outside provider driver package: its document
 * must be a valid outside entry once the host adds the facts only it can
 * state, it must speak a protocol version the host speaks, and its files must
 * be data and ES modules only, with no program, native code, or install
 * script, because the host runs the one entry module on its own runtime.
 */
export function readOutsideProviderDriverPackage(
  input: OutsideProviderDriverPackageInput,
): OutsideProviderDriverPackageReading {
  // Local folders are the only outside driver source until publisher
  // signatures exist; a marketplace package needs one.
  if (input.source.kind !== "local-folder") return refused("source-unsupported");
  const document = parseJsonFile(input.entries, OUTSIDE_PROVIDER_DRIVER_DOCUMENT_PATH);
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
  const reading = readOutsideProviderDriverEntry({ ...document, manifest });
  if (reading.status === "refused") return reading;
  if (!reading.entry.protocolVersions.some((version) => HOST_PROTOCOL_VERSIONS.has(version))) {
    return refused("protocol-incompatible");
  }
  const entryPoint = reading.entry.manifest.components[0]?.entryPoint;
  const filesRefusal = packageFilesRefusal(input.entries, entryPoint);
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
export class OutsideProviderDriverRefusedError extends Error {
  override readonly name = "OutsideProviderDriverRefusedError";

  constructor(readonly reason: OutsideProviderDriverRefusalReason) {
    super(outsideProviderDriverRefusalMessage(reason));
  }
}

/** Octant's own words for each refusal; nothing from the package is repeated. */
export function outsideProviderDriverRefusalMessage(
  reason: OutsideProviderDriverRefusalReason,
): string {
  switch (reason) {
    case "entry-invalid":
      return "This provider driver's description is not one Octant can read.";
    case "document-invalid":
      return "This provider driver's description file is missing or is not valid JSON.";
    case "host-assigned-field":
      return "This provider driver states its own identity, source, digest or review; Octant sets those itself.";
    case "bundled-source":
      return "A provider driver from outside Octant cannot say it is bundled with Octant.";
    case "bundled-kind-claim":
      return "This provider driver claims the name or entry of a driver bundled with Octant.";
    case "declares-capabilities":
      return "A provider driver declares no capabilities; Octant makes every call on its behalf.";
    case "declares-contributions":
      return "A provider driver adds nothing to Octant's windows.";
    case "not-one-provider-driver":
      return "A provider driver package holds exactly one provider driver and nothing else.";
    case "entry-point-not-package-relative":
      return "A provider driver's entry must be a JavaScript module inside its package.";
    case "entry-point-missing":
      return "This provider driver's entry module is not in its package.";
    case "source-unsupported":
      return "Provider drivers from outside Octant can be added only from a folder on this computer.";
    case "protocol-incompatible":
      return "This provider driver speaks no protocol version this version of Octant speaks.";
    case "ships-executable":
      return "This provider driver ships a program; a provider driver is JavaScript modules and data only.";
    case "ships-native-code":
      return "This provider driver ships native code; a provider driver is JavaScript modules and data only.";
    case "ships-install-script":
      return "This provider driver has an install script; Octant runs no install step for a provider driver.";
    case "package-metadata-invalid":
      return "A package description in this provider driver is not valid JSON.";
  }
}

function packageFilesRefusal(
  entries: ReadonlyArray<ExtensionArchiveEntry>,
  entryPoint: string | undefined,
): OutsideProviderDriverRefusalReason | undefined {
  const files = entries.filter((entry) => entry.kind === "file");
  if (entryPoint === undefined || !files.some((entry) => entry.path === entryPoint)) {
    return "entry-point-missing";
  }
  if (files.some((entry) => entry.executable === true)) return "ships-executable";
  if (files.some(isNativeCode)) return "ships-native-code";
  for (const file of files) {
    // macOS volumes are case-insensitive by default, so `Package.json` there is
    // the file npm reads as `package.json`.
    const name = (file.path.split("/").pop() ?? "").toLowerCase();
    // npm runs node-gyp for a package with a binding.gyp even without a script.
    if (name === "binding.gyp") return "ships-install-script";
    if (name !== "package.json") continue;
    const metadata = parseJson(file.content);
    if (!isRecord(metadata)) return "package-metadata-invalid";
    if (metadata.gypfile === true) return "ships-install-script";
    const scripts = metadata.scripts;
    if (scripts !== undefined && !isRecord(scripts)) return "package-metadata-invalid";
    if (isRecord(scripts) && INSTALL_LIFECYCLE_SCRIPTS.some((script) => script in scripts)) {
      return "ships-install-script";
    }
  }
  return undefined;
}

/**
 * Native code by name (Node addons and shared libraries) or by content (the
 * Mach-O, 32- and 64-bit universal, ELF, and PE headers), since a name proves
 * nothing.
 */
function isNativeCode(entry: ExtensionArchiveEntry): boolean {
  if (/\.(node|dylib|dll|exe)$/i.test(entry.path) || /\.so(\.\d+)*$/i.test(entry.path)) {
    return true;
  }
  const content = entry.content;
  if (content === undefined || content.byteLength < 4) return false;
  const magic = Array.from(content.subarray(0, 4), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toLowerCase();
  return NATIVE_MAGIC.has(magic) || magic.startsWith("4d5a");
}

const NATIVE_MAGIC: ReadonlySet<string> = new Set([
  "feedface",
  "feedfacf",
  "cefaedfe",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
  "7f454c46",
]);

function parseJsonFile(entries: ReadonlyArray<ExtensionArchiveEntry>, path: string): unknown {
  const entry = entries.find((candidate) => candidate.path === path && candidate.kind === "file");
  return parseJson(entry?.content);
}

function parseJson(content: Uint8Array | undefined): unknown {
  if (content === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refused(reason: OutsideProviderDriverRefusalReason): OutsideProviderDriverPackageReading {
  return { status: "refused", reason };
}

/**
 * The stored identity of a folder's driver, derived from the folder and the
 * slug so a new version from the same folder updates the same package, and a
 * package can never name itself into another one's identity.
 */
function stableUuid(seed: string): string {
  const bytes = createHash("sha256")
    .update(`octant.outside-provider-driver\0${seed}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
