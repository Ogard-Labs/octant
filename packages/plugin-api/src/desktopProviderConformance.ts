/**
 * Conformance for the desktop-provider seam.
 *
 * Proves a driver keeps the promises the host's lease service relies on: it
 * stops when cancelled, tags what it creates, sets a provider-side expiry when
 * it bills, reports an extension only when the provider confirms the new
 * expiry, reports absence only when the desktop is absent, and refuses rather
 * than degrades a command it does not support. The fixture maps each scenario
 * onto whatever backs the driver: an in-memory provider or a recorded
 * transport.
 */
import type { ComputerControlCommand } from "@octant/contracts/computer-use-plugin";
import type { DesktopHostTag, DesktopRecipe, UtcTimestamp } from "@octant/contracts";
import { decodeDesktopHostTag, decodeDesktopLeaseId, decodeUtcTimestamp } from "@octant/contracts";
import type { DesktopHandle, DesktopProvider } from "./desktopProvider";

export interface DesktopProviderConformanceScenario {
  /** The provider refuses to move a desktop's expiry. */
  readonly providerDeclinesExtension: boolean;
  /** The provider accepts a destroy but the desktop keeps running. */
  readonly desktopOutlivesDestroy: boolean;
}

export interface DesktopProviderConformanceFixture {
  /** A fresh driver whose provider behaves as `scenario` says. */
  readonly create: (scenario: DesktopProviderConformanceScenario) => DesktopProvider;
  readonly recipe: DesktopRecipe;
  /** A command this driver does not support, or none when it supports every one. */
  readonly unsupportedCommand?: ComputerControlCommand;
}

export interface DesktopProviderConformanceEvidence {
  readonly stoppedWhenCancelled: true;
  readonly taggedWhatItCreated: true;
  readonly setProviderExpiryWhenBilled: true;
  readonly extendedOnlyWhenConfirmed: true;
  readonly reportedAbsenceOnlyWhenAbsent: true;
  readonly refusedUnsupportedCommand: true;
}

const ORDINARY: DesktopProviderConformanceScenario = {
  providerDeclinesExtension: false,
  desktopOutlivesDestroy: false,
};

function assertConformance(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Desktop provider conformance failed: ${message}`);
}

async function answered<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new Error(`Desktop provider conformance failed: ${operation} threw instead of answering`);
  }
}

const freshHostTag = (): DesktopHostTag => decodeDesktopHostTag(globalThis.crypto.randomUUID());
const minutesFromNow = (minutes: number): UtcTimestamp =>
  decodeUtcTimestamp(new Date(Date.now() + minutes * 60_000).toISOString());

async function listsLease(
  provider: DesktopProvider,
  hostTag: DesktopHostTag,
  handle: DesktopHandle,
): Promise<boolean> {
  const listed = await answered("listOwned", () => provider.listOwned(hostTag));
  assertConformance(listed.status === "listed", "listOwned did not list a reachable provider");
  return listed.resources.some(
    (resource) =>
      String(resource.handle.leaseId) === String(handle.leaseId) &&
      String(resource.hostTag) === String(hostTag),
  );
}

async function acquire(provider: DesktopProvider, recipe: DesktopRecipe, hostTag: DesktopHostTag) {
  const leaseId = decodeDesktopLeaseId(globalThis.crypto.randomUUID());
  const expiresAt = minutesFromNow(30);
  const result = await answered("acquire", () =>
    provider.acquire({
      leaseId,
      hostTag,
      recipe,
      expiresAt,
      signal: new AbortController().signal,
    }),
  );
  assertConformance(result.status === "acquired", "acquire did not create a desktop");
  assertConformance(
    String(result.handle.leaseId) === String(leaseId),
    "the handle does not carry the lease id it was created for",
  );
  return { result, expiresAt };
}

export async function runDesktopProviderConformance(
  fixture: DesktopProviderConformanceFixture,
): Promise<DesktopProviderConformanceEvidence> {
  const provider = fixture.create(ORDINARY);
  const hostTag = freshHostTag();

  await answered("status", () => provider.status());

  const cancelledLease = decodeDesktopLeaseId(globalThis.crypto.randomUUID());
  const controller = new AbortController();
  controller.abort();
  const cancelled = await answered("acquire", () =>
    provider.acquire({
      leaseId: cancelledLease,
      hostTag,
      recipe: fixture.recipe,
      expiresAt: minutesFromNow(30),
      signal: controller.signal,
    }),
  );
  assertConformance(cancelled.status === "cancelled", "a cancelled acquire did not stop");
  const afterCancel = await answered("listOwned", () => provider.listOwned(hostTag));
  assertConformance(
    afterCancel.status === "listed" &&
      afterCancel.resources.every(
        (resource) => String(resource.handle.leaseId) !== String(cancelledLease),
      ),
    "a cancelled acquire left a desktop behind",
  );

  const { result: acquired, expiresAt } = await acquire(provider, fixture.recipe, hostTag);
  const handle = acquired.handle;
  assertConformance(
    await listsLease(provider, hostTag, handle),
    "the desktop is not listed under its lease id and host tag",
  );
  assertConformance(
    !(await listsLease(provider, freshHostTag(), handle)),
    "the desktop is listed under another host's tag",
  );

  if (provider.billed) {
    const providerExpiresAt =
      acquired.providerExpiresAt === undefined ? undefined : Date.parse(acquired.providerExpiresAt);
    assertConformance(
      providerExpiresAt !== undefined && providerExpiresAt >= Date.parse(expiresAt),
      "a billed desktop has no provider-side expiry at or after the lease expiry",
    );
  }

  const longer = decodeUtcTimestamp(new Date(Date.parse(expiresAt) + 30 * 60_000).toISOString());
  const extended = await answered("extend", () => provider.extend(handle, longer));
  assertConformance(
    extended.status === "extended" && Date.parse(extended.expiresAt) >= Date.parse(longer),
    "an extension the provider confirmed was not reported with the new expiry",
  );

  if (fixture.unsupportedCommand !== undefined) {
    const command = fixture.unsupportedCommand;
    const refused = await answered("control", () => provider.control(handle, command));
    assertConformance(
      refused.kind === "refused" && refused.reason === "unsupported",
      "an unsupported command was not refused as unsupported",
    );
  }

  await answered("release", () => provider.release(handle));
  const gone = await answered("verifyGone", () => provider.verifyGone(handle));
  assertConformance(gone.status === "gone", "a destroyed desktop was not reported gone");
  assertConformance(
    !(await listsLease(provider, hostTag, handle)),
    "a destroyed desktop is still listed",
  );

  const declining = fixture.create({ ...ORDINARY, providerDeclinesExtension: true });
  const declinedLease = await acquire(declining, fixture.recipe, hostTag);
  const declined = await answered("extend", () =>
    declining.extend(declinedLease.result.handle, longer),
  );
  assertConformance(
    declined.status !== "extended",
    "an extension the provider declined was reported as extended",
  );
  await answered("release", () => declining.release(declinedLease.result.handle));

  const lingering = fixture.create({ ...ORDINARY, desktopOutlivesDestroy: true });
  const lingeringLease = await acquire(lingering, fixture.recipe, hostTag);
  await answered("release", () => lingering.release(lingeringLease.result.handle));
  const stillThere = await answered("verifyGone", () =>
    lingering.verifyGone(lingeringLease.result.handle),
  );
  assertConformance(
    stillThere.status !== "gone",
    "a desktop that outlived its destroy was reported gone",
  );

  return {
    stoppedWhenCancelled: true,
    taggedWhatItCreated: true,
    setProviderExpiryWhenBilled: true,
    extendedOnlyWhenConfirmed: true,
    reportedAbsenceOnlyWhenAbsent: true,
    refusedUnsupportedCommand: true,
  };
}
