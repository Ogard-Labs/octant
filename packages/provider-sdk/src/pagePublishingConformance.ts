import {
  decodePagePublishAvailability,
  decodePagePublishOutcome,
  decodeProviderInstanceId,
  type PagePublishAvailability,
  type PagePublishOutcome,
  type PagePublishRequest,
  type ProviderInstanceId,
} from "@octant/contracts";
import type { ProviderPagePublishingSource } from "./pagePublishing";

export interface PagePublishingConformanceFixture {
  readonly source: ProviderPagePublishingSource;
  /** An instance the driver knows, signed in to an account that can publish. */
  readonly signedInInstanceId: ProviderInstanceId;
  /** An instance the driver knows on which no account is signed in. */
  readonly signedOutInstanceId: ProviderInstanceId;
  /** A request the signed-in instance publishes. */
  readonly request: PagePublishRequest;
  /** A request the provider refuses, so the refusal shows as a value. */
  readonly refusedRequest: PagePublishRequest;
}

export interface PagePublishingConformanceEvidence {
  readonly signedOutPublishesNothing: true;
  readonly unknownInstanceAbsent: true;
  readonly readyNamesAccount: true;
  readonly publishedNamesAddress: true;
  readonly refusalIsValue: true;
}

const UNKNOWN_INSTANCE_IDS = [
  "00000000-0000-4000-8000-00000000c0f0",
  "00000000-0000-4000-8000-00000000c0f1",
  "00000000-0000-4000-8000-00000000c0f2",
] as const;

function assertConformance(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Page publishing conformance failed: ${message}`);
}

function availabilityOf(
  source: ProviderPagePublishingSource,
  instanceId: ProviderInstanceId,
  what: string,
): PagePublishAvailability {
  let answer: unknown;
  try {
    answer = source.availability({ instanceId });
  } catch {
    throw new Error(`Page publishing conformance failed: availability threw for ${what}`);
  }
  try {
    return decodePagePublishAvailability(answer);
  } catch {
    throw new Error(
      `Page publishing conformance failed: availability for ${what} is not a page availability`,
    );
  }
}

async function publishTo(
  source: ProviderPagePublishingSource,
  instanceId: ProviderInstanceId,
  request: PagePublishRequest,
  what: string,
): Promise<PagePublishOutcome> {
  let answer: unknown;
  try {
    answer = await source.publish({ instanceId, ...request });
  } catch {
    throw new Error(`Page publishing conformance failed: publish rejected for ${what}`);
  }
  try {
    return decodePagePublishOutcome(answer);
  } catch {
    throw new Error(
      `Page publishing conformance failed: outcome for ${what} is not a page outcome`,
    );
  }
}

/**
 * Proves a page-publishing driver keeps the seam's promises: it publishes
 * nothing on an instance with no signed-in account and says so, knows no
 * instance it was not configured with, names the account a ready instance
 * publishes under, reports a publish as published only with an address, and
 * returns a provider's refusal as a value rather than throwing it. Every
 * answer must decode as the seam's shapes, so a message that carries a path
 * or a secret, or a published outcome without an address, fails here rather
 * than reaching a card.
 */
export async function runPagePublishingConformance(
  fixture: PagePublishingConformanceFixture,
): Promise<PagePublishingConformanceEvidence> {
  const { source } = fixture;
  const known = new Set([String(fixture.signedInInstanceId), String(fixture.signedOutInstanceId)]);
  const unknownId = UNKNOWN_INSTANCE_IDS.find((candidate) => !known.has(candidate));
  assertConformance(unknownId !== undefined, "the fixture leaves no unknown instance id");
  const unknown = decodeProviderInstanceId(unknownId);

  const signedOut = availabilityOf(source, fixture.signedOutInstanceId, "a signed-out instance");
  assertConformance(
    signedOut.kind === "not-signed-in",
    "a signed-out instance was not reported as not signed in",
  );
  const signedOutOutcome = await publishTo(
    source,
    fixture.signedOutInstanceId,
    fixture.request,
    "a signed-out instance",
  );
  assertConformance(
    signedOutOutcome.kind === "not-signed-in",
    "a publish on a signed-out instance did not answer not signed in",
  );

  const absent = availabilityOf(source, unknown, "an unknown instance");
  assertConformance(absent.kind === "absent", "an unknown instance was not reported as absent");
  const absentOutcome = await publishTo(source, unknown, fixture.request, "an unknown instance");
  assertConformance(
    absentOutcome.kind !== "published",
    "a publish on an unknown instance was reported as published",
  );

  const ready = availabilityOf(source, fixture.signedInInstanceId, "a signed-in instance");
  assertConformance(ready.kind === "ready", "a signed-in instance was not reported as ready");

  const published = await publishTo(
    source,
    fixture.signedInInstanceId,
    fixture.request,
    "a signed-in instance",
  );
  assertConformance(published.kind === "published", "a scripted publish was not published");

  const refused = await publishTo(
    source,
    fixture.signedInInstanceId,
    fixture.refusedRequest,
    "a refused request",
  );
  assertConformance(refused.kind === "refused", "a provider refusal was not returned as refused");

  return {
    signedOutPublishesNothing: true,
    unknownInstanceAbsent: true,
    readyNamesAccount: true,
    publishedNamesAddress: true,
    refusalIsValue: true,
  };
}
