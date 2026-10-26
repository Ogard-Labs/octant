import { Schema } from "effect";
import { ExtensionPackageManifest } from "@octant/contracts/extensions";

/**
 * The public schema for a language server a person adds to Octant themselves.
 * Canonical: docs/design/language-services.md (user-added `static` servers).
 *
 * A package holds exactly one `language-server` component of the `static`
 * class: a binary inside the package that Octant starts with no arguments and
 * speaks the Language Server Protocol on stdio. The class decides the
 * confinement, so the schema admits only the class this host can run without
 * an approval: the checkout read-only, the server's own cache the only place
 * it writes, no other program, and no network. Install, trust, enablement,
 * and the package's identity, source, and digest are facts the host
 * establishes through the activation ladder, so the document cannot carry
 * them, and any field this schema does not name is refused rather than
 * ignored.
 */

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The file at a language server package's root that holds its manifest. A
 * folder that has it is read as a language server package and as nothing
 * else.
 */
export const LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH = "octant-language-server.json";

/** The name of the language server Octant bundles, which no added package may take. */
const BUNDLED_LANGUAGE_SERVER_SLUGS: ReadonlySet<string> = new Set(["typescript-language-server"]);

/**
 * The capabilities a `static` server may declare: reading the checkout. Any
 * other one names an effect the class's confinement refuses, so a review that
 * listed it would describe something the server can never do.
 */
const STATIC_CAPABILITIES: ReadonlySet<string> = new Set(["filesystem"]);

/**
 * Why a language server package was refused. The set is closed and the host
 * words each reason itself: no text from the package reaches a person.
 *
 * The first group is decided by this schema alone; the second by the host
 * when it reads the package's files.
 */
export const LanguageServerPackageRefusalReason = Schema.Literal(
  "entry-invalid",
  "bundled-source",
  "bundled-claim",
  "not-one-language-server",
  "launch-class-unsupported",
  "declares-capabilities",
  "declares-contributions",
  "not-for-code",
  "provider-specific",
  "entry-point-not-package-relative",
  "source-unsupported",
  "document-invalid",
  "host-assigned-field",
  "entry-point-missing",
  "ships-other-program",
);
export type LanguageServerPackageRefusalReason = typeof LanguageServerPackageRefusalReason.Type;

const LanguageServerPackageEntryShape = Schema.Struct({
  manifest: ExtensionPackageManifest,
}).annotations(strict);
type LanguageServerPackageEntryShape = typeof LanguageServerPackageEntryShape.Type;

/**
 * An entry point is a file inside the package: relative, with no scheme (so
 * no `builtin:` server and no `file:` reach), and no empty, `.`, or `..`
 * segment.
 */
function isPackageRelativeFile(entryPoint: string): boolean {
  if (entryPoint.includes(":") || entryPoint.includes("\\") || entryPoint.startsWith("/")) {
    return false;
  }
  return entryPoint.split("/").every((segment) => segment !== "" && !/^\.+$/.test(segment));
}

function entryRefusal(
  entry: LanguageServerPackageEntryShape,
): LanguageServerPackageRefusalReason | undefined {
  const { manifest } = entry;
  if (manifest.source.kind === "bundled") return "bundled-source";
  if (BUNDLED_LANGUAGE_SERVER_SLUGS.has(manifest.slug)) return "bundled-claim";
  const [component, ...others] = manifest.components;
  if (
    component === undefined ||
    others.length > 0 ||
    component.kind !== "language-server" ||
    component.languageServer === undefined
  ) {
    return "not-one-language-server";
  }
  if (
    manifest.primaryComponentId !== undefined &&
    String(manifest.primaryComponentId) !== String(component.id)
  ) {
    return "not-one-language-server";
  }
  // A server that runs the repository's tooling needs the shell-command
  // approval, which this host does not hold for language servers yet; the
  // class is never narrowed to `static` on the author's behalf.
  if (component.languageServer.launchClass !== "static") return "launch-class-unsupported";
  if (
    manifest.declaredCapabilities.some((capability) => !STATIC_CAPABILITIES.has(capability)) ||
    component.declaredCapabilities.some((capability) => !STATIC_CAPABILITIES.has(capability))
  ) {
    return "declares-capabilities";
  }
  if (manifest.contributions !== undefined && manifest.contributions.length > 0) {
    return "declares-contributions";
  }
  if (manifest.compatibility.modes.some((mode) => mode !== "code")) return "not-for-code";
  // A language server reads the checkout for the editor; no provider is part
  // of that, so a package that names one describes something else.
  if (manifest.compatibility.providerFamilies.length > 0) return "provider-specific";
  const entryPoint = component.entryPoint ?? "";
  if (entryPoint.startsWith("builtin:")) return "bundled-claim";
  if (!isPackageRelativeFile(entryPoint)) return "entry-point-not-package-relative";
  return undefined;
}

export const LanguageServerPackageEntry = LanguageServerPackageEntryShape.pipe(
  Schema.filter((entry) => {
    const reason = entryRefusal(entry);
    return reason === undefined ? true : `A language server package is refused: ${reason}.`;
  }),
);
export type LanguageServerPackageEntry = typeof LanguageServerPackageEntry.Type;

export type LanguageServerPackageEntryReading =
  | { readonly status: "accepted"; readonly entry: LanguageServerPackageEntry }
  | { readonly status: "refused"; readonly reason: LanguageServerPackageRefusalReason };

const decodeShape = Schema.decodeUnknownEither(LanguageServerPackageEntryShape);

/** Reads a language server package's document, naming the closed reason when it is refused. */
export function readLanguageServerPackageEntry(value: unknown): LanguageServerPackageEntryReading {
  const decoded = decodeShape(value);
  if (decoded._tag === "Left") return { status: "refused", reason: "entry-invalid" };
  const reason = entryRefusal(decoded.right);
  return reason === undefined
    ? { status: "accepted", entry: decoded.right }
    : { status: "refused", reason };
}
