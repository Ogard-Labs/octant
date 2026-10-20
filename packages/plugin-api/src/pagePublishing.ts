/**
 * Page publishing as a plugin sees it: which enabled provider instances can
 * publish a page on the person's own account, and publishing one there. The
 * host resolves each instance through the provider seam's page-publishing
 * operation; a plugin never learns which provider, runtime, or tool answers.
 * The shapes live in `@octant/contracts/page-publishing`.
 */
import type {
  PagePublishAvailability,
  PagePublishOutcome,
  PagePublishRequest,
  ProviderInstanceId,
} from "@octant/contracts";

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
 * The host port a destination asks to publish a page. `publishers` is read
 * while an offer or an approval card is built, so it is synchronous and lists
 * only instances that are enabled, whose driver implements the operation, and
 * whose observed capabilities say pages are supported; `publish` to any other
 * instance is refused as a value. The host decodes every answer, so a
 * destination never sees a published outcome without an address.
 */
export interface PagePublishingPort {
  readonly publishers: () => ReadonlyArray<PagePublisherOffer>;
  readonly publish: (
    instanceId: ProviderInstanceId,
    request: PagePublishRequest,
  ) => Promise<PagePublishOutcome>;
}
