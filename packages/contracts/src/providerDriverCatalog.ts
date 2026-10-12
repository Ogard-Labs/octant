import { Schema } from "effect";
import { ExtensionPackageManifest } from "./extensions";
import { ProviderDriverKind } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * One provider driver the provider catalog lists. An entry is what a driver
 * package says about itself, nothing more: its manifest. It names no install,
 * trust, enable, credential, or capability state, because those are facts the
 * host establishes through the activation ladder and a connection check, and a
 * listing that could carry them could grant itself authority. Excess
 * properties are refused rather than ignored for the same reason.
 *
 * Only drivers bundled with Octant are listed for now. An entry from any other
 * source fails closed until outside drivers have their own reviewed design.
 */
export const ProviderDriverCatalogEntry = Schema.Struct({
  driverKind: ProviderDriverKind,
  manifest: ExtensionPackageManifest,
})
  .annotations(strict)
  .pipe(
    Schema.filter((entry) => {
      const { manifest } = entry;
      if (manifest.source.kind !== "bundled") {
        return "A provider catalog entry must come from a driver bundled with Octant.";
      }
      // A driver's capabilities are observed by a connection check, never
      // declared by its listing: a declared capability is a request for
      // authority the catalog has no way to grant.
      if (manifest.declaredCapabilities.length > 0) {
        return "A provider catalog entry declares no capabilities.";
      }
      if (manifest.contributions !== undefined && manifest.contributions.length > 0) {
        return "A provider catalog entry contributes nothing to the renderer.";
      }
      const [component, ...others] = manifest.components;
      if (component === undefined || others.length > 0) {
        return "A provider catalog entry holds exactly one provider-driver component.";
      }
      if (component.kind !== "provider-driver") {
        return "A provider catalog entry's component must be a provider driver.";
      }
      if (component.declaredCapabilities.length > 0) {
        return "A provider catalog entry declares no capabilities.";
      }
      if (
        manifest.primaryComponentId !== undefined &&
        String(manifest.primaryComponentId) !== String(component.id)
      ) {
        return "A provider catalog entry's primary component must be its driver.";
      }
      if (component.entryPoint !== `builtin:provider-driver/${entry.driverKind}`) {
        return "A provider catalog entry's driver must be the built-in driver for its kind.";
      }
      return true;
    }),
  );
export type ProviderDriverCatalogEntry = typeof ProviderDriverCatalogEntry.Type;

export const decodeProviderDriverCatalogEntry = Schema.decodeUnknownSync(
  ProviderDriverCatalogEntry,
);
