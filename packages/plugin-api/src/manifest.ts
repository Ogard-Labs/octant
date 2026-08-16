/**
 * Public plugin manifest and component vocabulary. Re-exports the schemas a
 * plugin author needs from `@octant/contracts/extensions`, which stays the
 * canonical definition site because the manifest composes core, widely
 * shared primitives (`OctantMode`, `ToolExtensionId`) that this package does
 * not own and should not duplicate.
 */
export {
  ExtensionCapability,
  ExtensionCatalogEntryId,
  ExtensionCatalogEpoch,
  ExtensionCatalogId,
  ExtensionCompatibility,
  ExtensionComponent,
  ExtensionComponentId,
  ExtensionComponentKind,
  ExtensionComponentQualifiedId,
  ExtensionContentDigest,
  ExtensionLicense,
  ExtensionManifestVersion,
  ExtensionPackageId,
  ExtensionPackageManifest,
  ExtensionPackageVersion,
  ExtensionPlatform,
  ExtensionProviderFamily,
  ExtensionProvenance,
  ExtensionSkillName,
  ExtensionSlug,
  ExtensionSource,
  ExtensionSourceKind,
  ExtensionSourceReference,
  decodeExtensionComponentId,
  decodeExtensionComponentQualifiedId,
  decodeExtensionContentDigest,
  decodeExtensionPackageId,
  decodeExtensionPackageManifest,
} from "@octant/contracts/extensions";
