/**
 * Renderer contribution-point vocabulary a manifest's `contributions` field
 * declares. Canonical definition stays in `@octant/contracts/extensions`
 * alongside `ExtensionPackageManifest`, which validates a contribution's
 * `componentId` against the manifest's own components.
 */
export {
  ExtensionContribution,
  ExtensionContributionPoint,
  ExtensionSettingsSectionContribution,
  ExtensionSidebarDestinationContribution,
} from "@octant/contracts/extensions";
