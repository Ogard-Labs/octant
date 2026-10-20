/**
 * Page publishing as a plugin sees it: which enabled provider instances can
 * publish a page on the person's own account. The host resolves each instance
 * through the provider seam's page-publishing operation; a plugin never learns
 * which provider, runtime, or tool answers. The shapes live in
 * `@octant/contracts/page-publishing`.
 *
 * Publishing itself is not on this port. It arrives only inside an approved
 * export, as the single-use grant in `CanvasExportGrants`
 * (`@octant/plugin-api/canvas-export`), because a long-lived port that could
 * publish would let a destination publish from its factory, while the card is
 * built, or with a page the person never approved.
 */
import type { PagePublishAvailability, ProviderInstanceId } from "@octant/contracts";

export type {
  PagePublishAvailability,
  PagePublishOutcome,
  PagePublishRequest,
} from "@octant/contracts/page-publishing";

/** One enabled provider instance that can publish pages, and whether it can right now. */
export interface PagePublisherOffer {
  readonly instanceId: ProviderInstanceId;
  /** The instance's display name, as the person named it in Settings. */
  readonly label: string;
  readonly availability: Exclude<PagePublishAvailability, { readonly kind: "absent" }>;
}

/**
 * The read a destination has while an offer or an approval card is built: the
 * instances that are enabled, whose driver implements the operation, and whose
 * observed capabilities say pages are supported. It is synchronous, and it
 * publishes nothing.
 */
export interface PagePublishingPort {
  readonly publishers: () => ReadonlyArray<PagePublisherOffer>;
}
