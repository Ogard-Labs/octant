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
} from "@octant/contracts";

export interface ProviderPagePublishAvailabilityInput {
  readonly instanceId: ProviderInstanceId;
}

export interface ProviderPagePublishInput extends PagePublishRequest {
  readonly instanceId: ProviderInstanceId;
}

/**
 * Publishing one HTML document as a private page on the person's own account
 * with this provider, outside any thread.
 *
 * A driver offers this only when it also reports `artifactPublish:
 * "supported"` in its observed capabilities; the host asks a driver that
 * lacks either nothing, and a page is never emulated for a provider without
 * one. `availability` is read while an offer or an approval card is built,
 * so it answers from what the driver already knows and starts nothing.
 * `publish` never rejects for an expected failure: an account that is not
 * signed in, a provider that refuses, and a runtime that cannot be run to
 * completion are each a value the caller must handle, so nothing is ever
 * presented as published that was not. The driver owns everything
 * provider-shaped (the tool or call that publishes, its input, its gate);
 * callers speak only in pages, refusals, and addresses.
 */
export interface ProviderPagePublishingSource {
  readonly availability: (input: ProviderPagePublishAvailabilityInput) => PagePublishAvailability;
  readonly publish: (input: ProviderPagePublishInput) => Promise<PagePublishOutcome>;
}
