import { Schema } from "effect";
import { ExtensionPackageManifest } from "@octant/contracts/extensions";
import { OutsideProviderDriverProtocolVersion } from "@octant/contracts/outside-driver-protocol";
import { ProviderDriverKind } from "@octant/contracts/providers";

/**
 * The public schema for a provider driver that does not ship with Octant.
 *
 * It is deliberately separate from the bundled `ProviderDriverCatalogEntry`,
 * which stays closed to bundled drivers. An outside entry names exactly one
 * provider-driver component whose entry is an ES module inside the package,
 * the harness endpoint protocol versions it speaks, and nothing else: it
 * declares no capabilities and contributes nothing, because a driver
 * translates a wire protocol and the host performs every effect on its
 * behalf. Install, trust, enablement, and credentials are facts the host
 * establishes through the activation ladder, so an entry cannot carry them,
 * and any field this schema does not name is refused rather than ignored.
 */

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The one driver-kind family every outside driver belongs to. */
export const OUTSIDE_PROVIDER_DRIVER_KIND = "outside-harness-endpoint" as const;

/**
 * The file at a driver package's root that holds its entry. A folder that has
 * it is read as an outside driver and as nothing else.
 */
export const OUTSIDE_PROVIDER_DRIVER_DOCUMENT_PATH = "octant-provider-driver.json";

/** A harness endpoint wire protocol major version, such as `harness-endpoint/1`. */
export { OutsideProviderDriverProtocolVersion };

/**
 * Why an outside driver package was refused. The set is closed and the host
 * words each reason itself: no text from the package reaches a person.
 *
 * The first group is decided by this schema alone; the second by the host
 * when it inspects the package's files.
 */
export const OutsideProviderDriverRefusalReason = Schema.Literal(
  "entry-invalid",
  "bundled-source",
  "bundled-kind-claim",
  "declares-capabilities",
  "declares-contributions",
  "not-one-provider-driver",
  "entry-point-not-package-relative",
  "source-unsupported",
  "document-invalid",
  "host-assigned-field",
  "protocol-incompatible",
  "entry-point-missing",
  "ships-executable",
  "ships-native-code",
  "ships-install-script",
  "package-metadata-invalid",
  "signature-missing",
  "signature-invalid",
);
export type OutsideProviderDriverRefusalReason = typeof OutsideProviderDriverRefusalReason.Type;

const OutsideProviderDriverEntryShape = Schema.Struct({
  driverKind: ProviderDriverKind,
  protocolVersions: Schema.Array(OutsideProviderDriverProtocolVersion).pipe(
    Schema.minItems(1),
    Schema.maxItems(8),
  ),
  manifest: ExtensionPackageManifest,
}).annotations(strict);
type OutsideProviderDriverEntryShape = typeof OutsideProviderDriverEntryShape.Type;

const bundledDriverKinds: ReadonlySet<string> = new Set(ProviderDriverKind.literals);

/**
 * An entry is an ES module file inside the package: relative, with no scheme
 * (so no `builtin:` driver and no `file:` reach), no `.` or `..` segment, and
 * the `.mjs` suffix. The host runs it on Bun or on Electron's Node, and `.mjs`
 * is the one suffix both load as plain JavaScript in an ES module: Node reads
 * a `.js` file as CommonJS when the nearest package.json says so, and the two
 * runtimes run TypeScript differently.
 */
function isPackageRelativeModule(entryPoint: string): boolean {
  if (entryPoint.includes(":") || entryPoint.includes("\\") || entryPoint.startsWith("/")) {
    return false;
  }
  if (entryPoint.split("/").some((segment) => segment === "" || /^\.+$/.test(segment))) {
    return false;
  }
  return entryPoint.endsWith(".mjs");
}

function entryRefusal(
  entry: OutsideProviderDriverEntryShape,
): OutsideProviderDriverRefusalReason | undefined {
  const { manifest } = entry;
  if (manifest.source.kind === "bundled") return "bundled-source";
  if (entry.driverKind !== OUTSIDE_PROVIDER_DRIVER_KIND) return "bundled-kind-claim";
  // A slug is the package's name in Settings and in `@` addressing; a bundled
  // driver kind's name there would read as that driver.
  if (bundledDriverKinds.has(manifest.slug)) return "bundled-kind-claim";
  if (
    manifest.declaredCapabilities.length > 0 ||
    manifest.components.some((component) => component.declaredCapabilities.length > 0)
  ) {
    return "declares-capabilities";
  }
  if (manifest.contributions !== undefined && manifest.contributions.length > 0) {
    return "declares-contributions";
  }
  const [component, ...others] = manifest.components;
  if (component === undefined || others.length > 0 || component.kind !== "provider-driver") {
    return "not-one-provider-driver";
  }
  if (
    manifest.primaryComponentId !== undefined &&
    String(manifest.primaryComponentId) !== String(component.id)
  ) {
    return "not-one-provider-driver";
  }
  const entryPoint = component.entryPoint ?? "";
  if (entryPoint.startsWith("builtin:")) return "bundled-kind-claim";
  if (!isPackageRelativeModule(entryPoint)) return "entry-point-not-package-relative";
  return undefined;
}

export const OutsideProviderDriverEntry = OutsideProviderDriverEntryShape.pipe(
  Schema.filter((entry) => {
    const reason = entryRefusal(entry);
    return reason === undefined ? true : `An outside provider driver entry is refused: ${reason}.`;
  }),
);
export type OutsideProviderDriverEntry = typeof OutsideProviderDriverEntry.Type;

export const decodeOutsideProviderDriverEntry = Schema.decodeUnknownSync(
  OutsideProviderDriverEntry,
);

export type OutsideProviderDriverEntryReading =
  | { readonly status: "accepted"; readonly entry: OutsideProviderDriverEntry }
  | { readonly status: "refused"; readonly reason: OutsideProviderDriverRefusalReason };

const decodeShape = Schema.decodeUnknownEither(OutsideProviderDriverEntryShape);

/** Reads an outside entry, naming the closed reason when it is refused. */
export function readOutsideProviderDriverEntry(value: unknown): OutsideProviderDriverEntryReading {
  const decoded = decodeShape(value);
  if (decoded._tag === "Left") return { status: "refused", reason: "entry-invalid" };
  const reason = entryRefusal(decoded.right);
  return reason === undefined
    ? { status: "accepted", entry: decoded.right }
    : { status: "refused", reason };
}

/**
 * The file beside the driver document that carries a publisher's signature.
 * Every source uses this one format: a local folder, an npm package, and any
 * later source alike.
 */
export const OUTSIDE_PROVIDER_DRIVER_SIGNATURE_PATH = "octant-signature.json";

/** The signature format this version of Octant reads. */
export const OUTSIDE_PROVIDER_DRIVER_SIGNATURE_FORMAT = "octant-signature/1";

const sha256Hex = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));

/**
 * A package-relative file path as the signature names it: `/`-separated,
 * with no empty, `.` or `..` segment and no control character, since the
 * signed message holds one path per line.
 */
const signedPath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(1024),
  Schema.filter(
    (path) =>
      // oxlint-disable-next-line no-control-regex -- control characters are what this refuses
      !/[\u0000-\u001f\u007f\\]/.test(path) &&
      !path.startsWith("/") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  ),
);

/**
 * `octant-signature.json`: the publisher's Ed25519 signature over the
 * package's name, version, protocol versions, and the SHA-256 of every other
 * file in it, with the public key that made it. The host recomputes every
 * hash itself and builds the signed message from its own reading, so this
 * file's `files` list is checked, never trusted.
 */
export const OutsideProviderDriverSignatureDocument = Schema.Struct({
  format: Schema.Literal(OUTSIDE_PROVIDER_DRIVER_SIGNATURE_FORMAT),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(214)),
  version: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  protocolVersions: Schema.Array(OutsideProviderDriverProtocolVersion).pipe(
    Schema.minItems(1),
    Schema.maxItems(8),
  ),
  files: Schema.Array(
    Schema.Struct({ path: signedPath, sha256: sha256Hex }).annotations(strict),
  ).pipe(Schema.maxItems(4096)),
  /** The 32 raw bytes of the Ed25519 public key, in standard base64. */
  publicKey: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9+/]{43}=$/)),
  /** The 64-byte Ed25519 signature over the signed message, in standard base64. */
  signature: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9+/]{86}==$/)),
}).annotations(strict);
export type OutsideProviderDriverSignatureDocument =
  typeof OutsideProviderDriverSignatureDocument.Type;

export const decodeOutsideProviderDriverSignatureDocument = Schema.decodeUnknownEither(
  OutsideProviderDriverSignatureDocument,
);

/** What a signature covers; the signed message is built from these alone. */
export interface OutsideProviderDriverSignedContent {
  readonly name: string;
  readonly version: string;
  readonly protocolVersions: ReadonlyArray<string>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly sha256: string }>;
}

/**
 * The exact bytes a publisher signs, as UTF-8 text of lines each ended by
 * one LF:
 *
 *     octant-signature/1
 *     name <name>
 *     version <version>
 *     protocol <version>           one line each, sorted, no repeats
 *     file <sha256 hex> <path>     one line each, sorted by the path's UTF-8 bytes
 *
 * A file line is every file in the package except the signature file
 * itself. Sorting by UTF-8 bytes is sorting by code point, which a plain
 * JavaScript string comparison is not for characters outside the Basic
 * Multilingual Plane, so the comparison here encodes first.
 */
export function outsideProviderDriverSignedMessage(
  content: OutsideProviderDriverSignedContent,
): Uint8Array {
  const encoder = new TextEncoder();
  const protocols = [...new Set(content.protocolVersions)].sort();
  const files = content.files
    .map((file) => ({ ...file, bytes: encoder.encode(file.path) }))
    .sort((left, right) => compareBytes(left.bytes, right.bytes));
  const lines = [
    OUTSIDE_PROVIDER_DRIVER_SIGNATURE_FORMAT,
    `name ${content.name}`,
    `version ${content.version}`,
    ...protocols.map((protocol) => `protocol ${protocol}`),
    ...files.map((file) => `file ${file.sha256} ${file.path}`),
  ];
  return encoder.encode(lines.map((line) => `${line}\n`).join(""));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}
