import { Schema } from "effect";

/**
 * Extension package identity primitives.
 *
 * These live apart from `extensions.ts` so the provider contract can name an
 * extension package without a module cycle: `extensions.ts` reads tool action
 * identifiers, and `toolActions.ts` reads provider instance identifiers. Effect
 * schemas are initialized at module load, so a cycle through those modules
 * would leave one side reading an uninitialized binding. `extensions.ts` and
 * `toolActions.ts` re-export these, so existing importers are unaffected.
 */

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const boundedToken = (maximumLength: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumLength),
    Schema.isPattern(/^[a-z][a-z0-9-]*$/),
  );

export const ToolExtensionId = brandedUuid("ToolExtensionId");
export type ToolExtensionId = typeof ToolExtensionId.Type;
export const ExtensionPackageId = brandedUuid("ExtensionPackageId");
export type ExtensionPackageId = typeof ExtensionPackageId.Type;
export const ExtensionComponentId = boundedToken(64).pipe(Schema.brand("ExtensionComponentId"));
export type ExtensionComponentId = typeof ExtensionComponentId.Type;
export const extensionSemverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const ExtensionPackageVersion = Schema.Trimmed.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(64),
    Schema.isPattern(extensionSemverPattern),
  ),
  Schema.brand("ExtensionPackageVersion"),
);
export type ExtensionPackageVersion = typeof ExtensionPackageVersion.Type;
export const ExtensionContentDigest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  Schema.brand("ExtensionContentDigest"),
);
export type ExtensionContentDigest = typeof ExtensionContentDigest.Type;

/**
 * A publisher's Ed25519 public key as Octant names it: `ed25519:` and the
 * lowercase hex SHA-256 of the key's 32 raw bytes. The host computes it from
 * the key in a package's verified signature; a package never states it.
 */
export const ExtensionPublisherKeyFingerprint = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^ed25519:[a-f0-9]{64}$/)),
  Schema.brand("ExtensionPublisherKeyFingerprint"),
);
export type ExtensionPublisherKeyFingerprint = typeof ExtensionPublisherKeyFingerprint.Type;

/**
 * A package name as npm accepts it for a new package: an optional lowercase
 * `@scope/` and one name segment, 214 characters at most.
 */
export const ExtensionNpmPackageName = Schema.String.check(
  Schema.isMaxLength(214),
  Schema.isPattern(/^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/),
);
export type ExtensionNpmPackageName = typeof ExtensionNpmPackageName.Type;

/**
 * Where an npm package's bytes came from, as the host fetched and checked
 * them: the package, the exact version, the registry that served it, and the
 * integrity the registry published for the tarball, which the host recomputed
 * over the bytes it downloaded. Only the host sets it.
 */
export const ExtensionNpmSource = Schema.Struct({
  packageName: ExtensionNpmPackageName,
  version: ExtensionPackageVersion,
  registry: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(2048),
    Schema.makeFilter((value) => {
      try {
        const parsed = new URL(value);
        return (
          (parsed.protocol === "https:" || parsed.protocol === "http:") &&
          parsed.username.length === 0 &&
          parsed.password.length === 0
        );
      } catch {
        return false;
      }
    }),
  ),
  integrity: Schema.String.check(
    Schema.isMaxLength(200),
    Schema.isPattern(/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/),
  ),
});
export type ExtensionNpmSource = typeof ExtensionNpmSource.Type;
