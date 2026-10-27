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
