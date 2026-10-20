import {
  decodePagePublishAvailability,
  decodePagePublishOutcome,
  decodePagePublishRequest,
  type PagePublishOutcome,
  type PagePublishRequest,
  type ProviderInstance,
  type ProviderInstanceId,
  type ProviderObservedState,
} from "@octant/contracts";
import type { PagePublisherOffer, PagePublishingPort } from "@octant/plugin-api/page-publishing";
import type { ProviderDriver, ProviderPagePublishingSource } from "@octant/provider-sdk";

/**
 * The host's page publishing: every enabled provider instance whose driver
 * implements the seam's page-publishing operation and whose probe observed
 * `artifactPublish: "supported"` on a ready runtime, and nothing else. It
 * names no vendor: it resolves the instance's driver, asks the seam, and
 * decodes what comes back. A driver's rejection or a malformed answer is
 * reported as unavailable in fixed words, so a provider's own error text
 * never reaches a card, and a publish to an instance the list does not hold
 * is refused as a value before any driver is asked.
 *
 * `publishers` is the plugin-facing port. `publish` stays host-internal: the
 * Canvas export service calls it only from the single-use grant it issues
 * inside an approved export, with the render the person approved, so no
 * destination ever holds it.
 */
export interface ProviderPagePublishingOptions {
  readonly instances: () => ReadonlyArray<ProviderInstance>;
  /** The configured driver for an enabled instance, or nothing when it cannot be built. */
  readonly resolveDriver: (instance: ProviderInstance) => ProviderDriver | undefined;
  readonly observedState: (instanceId: ProviderInstanceId) => ProviderObservedState | undefined;
}

export interface ProviderPagePublishing extends PagePublishingPort {
  readonly publish: (
    instanceId: ProviderInstanceId,
    request: PagePublishRequest,
  ) => Promise<PagePublishOutcome>;
}

const NOT_A_PUBLISHER = "This provider cannot publish pages.";
const MALFORMED_REQUEST = "The page is not one this host can publish.";
const NOT_ANSWERED = "The provider could not be asked to publish the page.";
const MALFORMED_OUTCOME = "The provider did not report the publish in a form this host accepts.";

interface Publisher {
  readonly offer: PagePublisherOffer;
  readonly source: ProviderPagePublishingSource;
}

function publisherOf(
  options: ProviderPagePublishingOptions,
  instance: ProviderInstance,
): Publisher | undefined {
  if (!instance.enabled) return undefined;
  const observed = options.observedState(instance.id);
  if (observed?.readiness !== "ready" || observed.capabilities.artifactPublish !== "supported") {
    return undefined;
  }
  const source = options.resolveDriver(instance)?.pagePublishing;
  if (source === undefined) return undefined;
  let availability;
  try {
    availability = decodePagePublishAvailability(source.availability({ instanceId: instance.id }));
  } catch {
    return undefined;
  }
  if (availability.kind === "absent") return undefined;
  return {
    offer: { instanceId: instance.id, label: instance.displayName, availability },
    source,
  };
}

export function makeProviderPagePublishing(
  options: ProviderPagePublishingOptions,
): ProviderPagePublishing {
  const publishers = (): ReadonlyArray<Publisher> =>
    options
      .instances()
      .map((instance) => publisherOf(options, instance))
      .filter((publisher): publisher is Publisher => publisher !== undefined);

  const publish = async (
    instanceId: ProviderInstanceId,
    request: PagePublishRequest,
  ): Promise<PagePublishOutcome> => {
    const publisher = publishers().find(
      (candidate) => String(candidate.offer.instanceId) === String(instanceId),
    );
    if (publisher === undefined) return { kind: "refused", message: NOT_A_PUBLISHER };
    let accepted: PagePublishRequest;
    try {
      accepted = decodePagePublishRequest(request);
    } catch {
      return { kind: "refused", message: MALFORMED_REQUEST };
    }
    let answer: unknown;
    try {
      answer = await publisher.source.publish({ instanceId, ...accepted });
    } catch {
      return { kind: "unavailable", message: NOT_ANSWERED };
    }
    try {
      return decodePagePublishOutcome(answer);
    } catch {
      return { kind: "unavailable", message: MALFORMED_OUTCOME };
    }
  };

  return {
    publishers: () => publishers().map((publisher) => publisher.offer),
    publish,
  };
}
