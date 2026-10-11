/**
 * The public schema a provider catalog entry is validated against. Re-exported
 * from `@octant/contracts`, which stays the definition site, so a driver
 * package and the host read one rule for what a listing may say.
 */
export {
  ProviderDriverCatalogEntry,
  decodeProviderDriverCatalogEntry,
} from "@octant/contracts/provider-driver-catalog";
