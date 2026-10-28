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

const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedToken = (maximumLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(maximumLength),
    Schema.pattern(/^[a-z][a-z0-9-]*$/),
  );

export const ToolExtensionId = brandedUuid("ToolExtensionId");
export type ToolExtensionId = typeof ToolExtensionId.Type;
export const ExtensionPackageId = brandedUuid("ExtensionPackageId");
export type ExtensionPackageId = typeof ExtensionPackageId.Type;
export const ExtensionComponentId = boundedToken(64).pipe(Schema.brand("ExtensionComponentId"));
export type ExtensionComponentId = typeof ExtensionComponentId.Type;
export const extensionSemverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const ExtensionPackageVersion = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(64),
  Schema.pattern(extensionSemverPattern),
  Schema.brand("ExtensionPackageVersion"),
);
export type ExtensionPackageVersion = typeof ExtensionPackageVersion.Type;
export const ExtensionContentDigest = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/),
  Schema.brand("ExtensionContentDigest"),
);
export type ExtensionContentDigest = typeof ExtensionContentDigest.Type;

/**
 * A publisher's Ed25519 public key as Octant names it: `ed25519:` and the
 * lowercase hex SHA-256 of the key's 32 raw bytes. The host computes it from
 * the key in a package's verified signature; a package never states it.
 */
export const ExtensionPublisherKeyFingerprint = Schema.String.pipe(
  Schema.pattern(/^ed25519:[a-f0-9]{64}$/),
  Schema.brand("ExtensionPublisherKeyFingerprint"),
);
export type ExtensionPublisherKeyFingerprint = typeof ExtensionPublisherKeyFingerprint.Type;
