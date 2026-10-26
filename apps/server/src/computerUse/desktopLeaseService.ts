import {
  AggregateId,
  CorrelationId,
  DESKTOP_LEASE_AGGREGATE_TYPE,
  DESKTOP_LEASE_EVENT_NAMES,
  EventId,
  decodeAggregateVersion,
  decodeDesktopLeaseId,
  decodeUtcTimestamp,
  type ComputerControlCommand,
  type ComputerControlResult,
  type DesktopHostTag,
  type DesktopLease,
  type DesktopLeaseEndReason,
  type DesktopLeaseId,
  type DesktopLeaseOwner,
  type DesktopLeaseRefusal,
  type DesktopLeaseRefusalReason,
  type DesktopLeaseRequested,
  type DesktopLeaseState,
  type DesktopLeaseTransitioned,
  type DesktopRecipe,
  type EventActor,
  type LeasableDesktopProvider,
  type OctantMode,
  type ProviderExecutionPolicy,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  cacheBackoffHolds,
  decideDesktopLeaseAcquire,
  decideDesktopLeaseExtension,
  desktopLeaseClockEnds,
  desktopLeaseFits,
  desktopLeaseHoldsDesktop,
  desktopLeaseTransitionAllowed,
  desktopProviderExpiryHolds,
  extendCacheBackoff,
  type CacheBackoff,
} from "@octant/domain";
import type {
  DesktopHandle,
  DesktopProvider,
  DesktopTeardownPort,
} from "@octant/plugin-api/desktop-provider";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import {
  reportComputerUseDestination,
  type ComputerUseDestinationReport,
} from "./computerUseDestination";
import type { DesktopLeaseProjection, DesktopLeaseRecord } from "./desktopLeaseProjection";

/**
 * The host's lease service for disposable desktops.
 *
 * It owns leases end to end: authority before any provider call, journaling
 * before create, the lease clocks, teardown, restart reconciliation, and
 * verified release. A driver only translates. Every refusal is a value.
 *
 * Teardown is the one path revocation does not close. It runs as `system`,
 * needs only the lease id, and holds the driver as a {@link DesktopTeardownPort}
 * so a driver kept loaded after its recipe or plugin was revoked can destroy
 * and verify but never acquire or operate. Operating commands always resolve
 * the driver afresh through `providers()` and require it to be effective.
 */

/** A driver the host has loaded, effective or not. A non-effective one serves teardown only. */
export interface RegisteredDesktopProvider {
  readonly provider: DesktopProvider;
  /** Installed, trusted, enabled, and effective for leasing now. */
  readonly effective: boolean;
}

export interface DesktopLeaseThread {
  /** False once the thread is archived, completed, or deleted. */
  readonly active: boolean;
  readonly executionPolicy: ProviderExecutionPolicy;
}

export interface DesktopLeaseConfirmation {
  readonly owner: DesktopLeaseOwner;
  readonly provider: LeasableDesktopProvider;
  /** `billed` asks a person in every posture; `in-thread` follows the thread's approvals. */
  readonly asks: "in-thread" | "billed";
  readonly leaseMinutes: number;
}

export interface DesktopLeaseServiceOptions {
  readonly journal: Pick<Journal, "append">;
  readonly projection: DesktopLeaseProjection;
  readonly hostTag: DesktopHostTag;
  readonly platform: NodeJS.Platform;
  /** Whether this host has its own screen computer use can drive. */
  readonly hasScreen: boolean;
  readonly providers: () => ReadonlyArray<RegisteredDesktopProvider>;
  readonly recipe: (owner: DesktopLeaseOwner) => DesktopRecipe | undefined;
  readonly thread: (owner: DesktopLeaseOwner) => DesktopLeaseThread | undefined;
  /** Whether a person's window or device, or an agent's turn, may open the thread. */
  readonly callerMayOpen: (actor: EventActor, owner: DesktopLeaseOwner) => boolean;
  readonly computerUseEnabled: () => boolean;
  readonly confirm: (request: DesktopLeaseConfirmation) => Promise<"approved" | "declined">;
  readonly systemActor: EventActor;
  readonly now: () => number;
  readonly uuid: () => string;
  /** How long one teardown call may take before it counts as failed. */
  readonly teardownTimeoutMs?: number;
}

export interface DesktopLeaseCaller {
  readonly owner: { readonly mode: OctantMode; readonly threadId: string };
  readonly actor: EventActor;
}

export type DesktopLeaseAcquireResult =
  | { readonly status: "acquired"; readonly lease: DesktopLease }
  /** The provider refused or failed after the lease was journaled. */
  | { readonly status: "not-acquired"; readonly lease: DesktopLease }
  | DesktopLeaseRefusal;

export type DesktopLeaseReleaseResult =
  | { readonly status: "released"; readonly lease: DesktopLease }
  /** The provider is still creating the desktop; it is destroyed as soon as it exists. */
  | { readonly status: "releasing"; readonly lease: DesktopLease }
  | { readonly status: "release-failed"; readonly lease: DesktopLease }
  | DesktopLeaseRefusal;

export type DesktopLeaseExtendResult =
  | { readonly status: "extended"; readonly lease: DesktopLease }
  | DesktopLeaseRefusal;

export type DesktopLeaseControlResult =
  | { readonly status: "answered"; readonly result: ComputerControlResult }
  | DesktopLeaseRefusal;

export interface DesktopLeaseReconciliation {
  /** Unreleased leases verified gone. */
  readonly released: number;
  /** Leases and untracked desktops that may still be running. */
  readonly stillRunning: number;
  /** Tagged desktops with no live lease that were destroyed and verified gone. */
  readonly orphansDestroyed: number;
}

export interface DesktopLeaseService {
  /** Reconciles restart state. Every acquire waits for it. */
  readonly start: () => Promise<DesktopLeaseReconciliation>;
  readonly destination: () => ComputerUseDestinationReport;
  readonly acquire: (
    caller: DesktopLeaseCaller & { readonly signal?: AbortSignal },
  ) => Promise<DesktopLeaseAcquireResult>;
  /** A person's or the owning agent's release of one of the thread's leases. */
  readonly release: (
    caller: DesktopLeaseCaller & { readonly leaseId: DesktopLeaseId },
  ) => Promise<DesktopLeaseReleaseResult>;
  /** A person's Retry on a lease that may still be running, from anywhere on the host. */
  readonly retryRelease: (input: {
    readonly leaseId: DesktopLeaseId;
    readonly actor: EventActor;
  }) => Promise<DesktopLeaseReleaseResult>;
  readonly extend: (
    caller: DesktopLeaseCaller & { readonly leaseId: DesktopLeaseId; readonly byMinutes: number },
  ) => Promise<DesktopLeaseExtendResult>;
  /**
   * Sends one `octant_computer` command. Approvals, sensitive-field
   * protection, and taint stay with the tool binding that calls this.
   */
  readonly control: (
    caller: DesktopLeaseCaller & {
      readonly leaseId: DesktopLeaseId;
      readonly command: ComputerControlCommand;
    },
  ) => Promise<DesktopLeaseControlResult>;
  /** A Desktop tab opened or closed on a lease; an open tab holds idle release off. */
  readonly markTab: (leaseId: DesktopLeaseId, change: "opened" | "closed") => void;
  /** Ends leases whose clock, thread, recipe, provider, or setting ended them; retries failed releases. */
  readonly sweep: () => Promise<void>;
}

/** What the host holds in memory for a lease that may still have a desktop. */
interface LiveLease {
  handle?: DesktopHandle;
  teardown?: DesktopTeardownPort;
  acquiring?: AbortController;
  pendingEnd?: { readonly reason: DesktopLeaseEndReason; readonly requestedBy?: EventActor };
  lastActivityAt: number;
  openTabs: number;
  backoff?: CacheBackoff;
}

/** A tagged desktop with no live lease that a destroy has not yet verified gone. */
interface Orphan {
  readonly teardown: DesktopTeardownPort;
  readonly leaseId: DesktopLeaseId;
  readonly handle?: DesktopHandle;
  backoff?: CacheBackoff;
}

type Destroyed =
  | { readonly kind: "gone" }
  | { readonly kind: "still-running"; readonly detail: string };

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const DEFAULT_TEARDOWN_TIMEOUT_MS = 60_000;
const ACQUIRE_FAILURE_DETAIL = {
  refused: "The provider refused to create the desktop.",
  failed: "The provider failed to create the desktop.",
  cancelled: "The acquisition was cancelled before the desktop was ready.",
  "not-connected": "The provider could not be reached.",
} as const;
const refused = (reason: DesktopLeaseRefusalReason): DesktopLeaseRefusal => ({
  status: "refused",
  reason,
});
const isPerson = (actor: EventActor): boolean =>
  actor.kind === "local-user" || actor.kind === "remote-device";
const sameOwner = (left: DesktopLeaseOwner, right: DesktopLeaseOwner): boolean =>
  left.mode === right.mode && String(left.threadId) === String(right.threadId);

/**
 * Calls into a driver so that a synchronous throw arrives as a rejection. A
 * plugin's driver is untrusted code; without this, one that throws before
 * returning a promise escapes every `.catch` below and aborts the sweep or the
 * restart reconciliation for every other lease.
 */
function driverCall<T>(call: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(call()));
}

function teardownPortOf(provider: DesktopTeardownPort): DesktopTeardownPort {
  return {
    id: provider.id,
    release: (handle) => provider.release(handle),
    verifyGone: (handle) => provider.verifyGone(handle),
    listOwned: (hostTag) => provider.listOwned(hostTag),
  };
}

/** A recipe whose provider or credential reference changed counts as removed. */
function recipeStillCovers(recipe: DesktopRecipe | undefined, lease: DesktopLease): boolean {
  return (
    recipe !== undefined &&
    String(recipe.providerId) === String(lease.providerId) &&
    String(recipe.credentialRef ?? "") === String(lease.credentialRef ?? "")
  );
}

function leasableOf(provider: DesktopProvider): LeasableDesktopProvider {
  return {
    providerId: provider.id,
    displayName: provider.displayName.trim().slice(0, 128) || String(provider.id),
    locality: provider.locality,
    billed: provider.billed,
  };
}

export function createDesktopLeaseService(
  options: DesktopLeaseServiceOptions,
): DesktopLeaseService {
  const { journal, projection, hostTag } = options;
  const teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
  const live = new Map<string, LiveLease>();
  const orphans = new Map<string, Orphan>();
  const serial = new Map<string, Promise<unknown>>();
  let reconciliation: Promise<DesktopLeaseReconciliation> | undefined;
  let sweeping: Promise<void> | undefined;
  let sweepAgain = false;

  const iso = (ms: number): UtcTimestamp => decodeUtcTimestamp(new Date(ms).toISOString());

  /** Runs one lease's changes in order, so a sweep and a release never race. */
  function inOrder<T>(leaseId: DesktopLeaseId, work: () => Promise<T>): Promise<T> {
    const key = String(leaseId);
    const previous = serial.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    serial.set(key, settled);
    void settled.then(() => {
      if (serial.get(key) === settled) serial.delete(key);
    });
    return next;
  }

  function append(
    record: DesktopLeaseRecord | undefined,
    leaseId: DesktopLeaseId,
    eventName: string,
    payload: unknown,
    actor: EventActor,
  ): void {
    journal.append({
      aggregate: {
        aggregateType: DESKTOP_LEASE_AGGREGATE_TYPE,
        aggregateId: decodeAggregateId(String(leaseId)),
      },
      expectedVersion: decodeAggregateVersion(record?.version ?? 0),
      events: [
        {
          eventId: decodeEventId(options.uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(options.uuid()),
          actor,
          occurredAt: iso(options.now()),
          payload,
        },
      ],
    });
  }

  function read(leaseId: DesktopLeaseId): DesktopLeaseRecord {
    const record = projection.get(leaseId);
    if (record === undefined)
      throw new Error("A journaled desktop lease is missing from its projection.");
    return record;
  }

  function transition(
    leaseId: DesktopLeaseId,
    to: DesktopLeaseState,
    actor: EventActor,
    extra: Partial<Pick<DesktopLeaseTransitioned, "endReason" | "requestedBy" | "detail">> = {},
  ): DesktopLease {
    const record = read(leaseId);
    const from = record.lease.state;
    if (!desktopLeaseTransitionAllowed(from, to)) {
      throw new Error(`A desktop lease cannot move from ${from} to ${to}.`);
    }
    const payload: DesktopLeaseTransitioned = {
      leaseId,
      owner: record.lease.owner,
      providerId: record.lease.providerId,
      from,
      to,
      ...(extra.endReason === undefined ? {} : { endReason: extra.endReason }),
      ...(extra.requestedBy === undefined ? {} : { requestedBy: extra.requestedBy }),
      ...(extra.detail === undefined ? {} : { detail: extra.detail.slice(0, 512) }),
    };
    append(record, leaseId, DESKTOP_LEASE_EVENT_NAMES.transitioned, payload, actor);
    return read(leaseId).lease;
  }

  function registered(providerId: string): RegisteredDesktopProvider | undefined {
    return options.providers().find((entry) => String(entry.provider.id) === providerId);
  }

  /** A provider is blocked while any desktop it made may still be running unverified. */
  function blocked(providerId: string): boolean {
    return (
      projection
        .list()
        .some(
          (record) =>
            record.lease.state === "release-failed" &&
            String(record.lease.providerId) === providerId,
        ) || [...orphans.values()].some((orphan) => String(orphan.teardown.id) === providerId)
    );
  }

  /** Bounds one teardown call: a provider that never answers counts as failed, not as gone. */
  async function bounded<T>(call: () => Promise<T>, timedOut: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        driverCall(call).catch(() => timedOut),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), teardownTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Destroys a lease's desktop and confirms it is absent. Without a handle the
   * provider's own tagged listing finds it; a listing that answers without it
   * is the provider confirming absence.
   */
  async function destroy(
    teardown: DesktopTeardownPort,
    leaseId: DesktopLeaseId,
    handle: DesktopHandle | undefined,
  ): Promise<Destroyed> {
    let handles: ReadonlyArray<DesktopHandle>;
    if (handle === undefined) {
      const listed = await bounded(() => teardown.listOwned(hostTag), {
        status: "failed" as const,
        reason: "timed-out",
      });
      if (listed.status !== "listed") {
        return { kind: "still-running", detail: "The provider could not list its desktops." };
      }
      handles = listed.resources
        .filter(
          (resource) =>
            String(resource.hostTag) === String(hostTag) &&
            String(resource.handle.leaseId) === String(leaseId),
        )
        .map((resource) => resource.handle);
    } else {
      handles = [handle];
    }
    for (const each of handles) {
      await bounded(() => teardown.release(each), {
        status: "failed" as const,
        reason: "timed-out",
      });
      const verified = await bounded(() => teardown.verifyGone(each), {
        status: "failed" as const,
        reason: "timed-out",
      });
      if (verified.status !== "gone") {
        return {
          kind: "still-running",
          detail:
            verified.status === "present"
              ? "The provider still reports the desktop after destroy."
              : "The provider could not confirm the desktop is gone.",
        };
      }
    }
    return { kind: "gone" };
  }

  function teardownFor(
    leaseId: DesktopLeaseId,
    providerId: string,
  ): DesktopTeardownPort | undefined {
    const retained = live.get(String(leaseId))?.teardown;
    if (retained !== undefined) return retained;
    const loaded = registered(providerId);
    return loaded === undefined ? undefined : teardownPortOf(loaded.provider);
  }

  /**
   * The teardown path. Ends a lease that may still hold a desktop and writes
   * `released` only once the provider confirms absence.
   */
  async function end(
    leaseId: DesktopLeaseId,
    reason: DesktopLeaseEndReason,
    requestedBy: EventActor | undefined,
  ): Promise<DesktopLeaseReleaseResult> {
    const key = String(leaseId);
    const record = read(leaseId);
    const state = record.lease.state;
    if (!desktopLeaseHoldsDesktop(state)) return refused("lease-ended");
    const entry = live.get(key);
    if (entry?.acquiring !== undefined) {
      // The provider is still creating it. The acquire path finishes the
      // teardown once it has a handle, so nothing is left behind.
      entry.pendingEnd = requestedBy === undefined ? { reason } : { reason, requestedBy };
      entry.acquiring.abort();
      return { status: "releasing", lease: record.lease };
    }
    if (state !== "releasing" && state !== "release-failed") {
      transition(leaseId, "releasing", options.systemActor, {
        endReason: reason,
        ...(requestedBy === undefined ? {} : { requestedBy }),
      });
    }
    const teardown = teardownFor(leaseId, String(record.lease.providerId));
    const destroyed: Destroyed =
      teardown === undefined
        ? { kind: "still-running", detail: "The provider's driver is not loaded on this host." }
        : await destroy(teardown, leaseId, entry?.handle);
    if (destroyed.kind === "gone") {
      live.delete(key);
      return { status: "released", lease: transition(leaseId, "released", options.systemActor) };
    }
    const kept: LiveLease = entry ?? { lastActivityAt: options.now(), openTabs: 0 };
    if (teardown !== undefined) kept.teardown = teardown;
    kept.backoff = extendCacheBackoff(kept.backoff, options.now());
    live.set(key, kept);
    const current = read(leaseId).lease;
    if (current.state === "release-failed") return { status: "release-failed", lease: current };
    return {
      status: "release-failed",
      lease: transition(leaseId, "release-failed", options.systemActor, {
        detail: destroyed.detail,
      }),
    };
  }

  async function destroyOrphan(key: string, orphan: Orphan): Promise<boolean> {
    const destroyed = await destroy(orphan.teardown, orphan.leaseId, orphan.handle);
    if (destroyed.kind === "gone") {
      orphans.delete(key);
      return true;
    }
    orphan.backoff = extendCacheBackoff(orphan.backoff, options.now());
    orphans.set(key, orphan);
    return false;
  }

  /** After a failed acquire, makes sure the provider kept nothing under that lease id. */
  async function reapStray(teardown: DesktopTeardownPort, leaseId: DesktopLeaseId): Promise<void> {
    await destroyOrphan(`stray:${String(leaseId)}`, { teardown, leaseId });
  }

  async function reconcile(): Promise<DesktopLeaseReconciliation> {
    let released = 0;
    let orphansDestroyed = 0;
    const unreleased = projection
      .list()
      .filter((record) => desktopLeaseHoldsDesktop(record.lease.state));
    const unreleasedIds = new Set(unreleased.map((record) => String(record.lease.leaseId)));
    const listings = new Map<string, ReadonlyArray<DesktopHandle>>();
    for (const entry of options.providers()) {
      const teardown = teardownPortOf(entry.provider);
      const listed = await bounded(() => teardown.listOwned(hostTag), {
        status: "failed" as const,
        reason: "timed-out",
      });
      if (listed.status !== "listed") continue;
      const handles = listed.resources
        .filter((resource) => String(resource.hostTag) === String(hostTag))
        .map((resource) => resource.handle);
      listings.set(String(entry.provider.id), handles);
      for (const handle of handles) {
        if (unreleasedIds.has(String(handle.leaseId))) continue;
        if (
          await destroyOrphan(`orphan:${String(entry.provider.id)}:${handle.resource}`, {
            teardown,
            leaseId: handle.leaseId,
            handle,
          })
        ) {
          orphansDestroyed += 1;
        }
      }
    }
    for (const record of unreleased) {
      const leaseId = record.lease.leaseId;
      const providerId = String(record.lease.providerId);
      const handles = listings.get(providerId);
      const entry: LiveLease = { lastActivityAt: options.now(), openTabs: 0 };
      const loaded = registered(providerId);
      if (loaded !== undefined) entry.teardown = teardownPortOf(loaded.provider);
      const handle = handles?.find((each) => String(each.leaseId) === String(leaseId));
      if (handle !== undefined) entry.handle = handle;
      live.set(String(leaseId), entry);
      const result = await inOrder(leaseId, () => end(leaseId, "host-restart", undefined));
      if (result.status === "released") released += 1;
    }
    const stillRunning =
      projection.list().filter((record) => record.lease.state === "release-failed").length +
      orphans.size;
    return { released, stillRunning, orphansDestroyed };
  }

  const start = (): Promise<DesktopLeaseReconciliation> => {
    reconciliation ??= reconcile();
    return reconciliation;
  };

  type Admitted = {
    readonly status: "admitted";
    readonly owner: DesktopLeaseOwner;
    readonly thread: DesktopLeaseThread;
    readonly recipe: DesktopRecipe;
    readonly provider: DesktopProvider;
  };

  function admitAcquire(caller: DesktopLeaseCaller): Admitted | DesktopLeaseRefusal {
    const { mode, threadId } = caller.owner;
    if (mode !== "work" && mode !== "code") return refused("not-leasable-mode");
    const owner: DesktopLeaseOwner = { mode, threadId };
    const thread = options.thread(owner);
    if (thread === undefined || !thread.active) return refused("thread-not-active");
    const authorityRefusal = refuseCaller(caller.actor, owner);
    if (authorityRefusal !== undefined) return authorityRefusal;
    if (!options.computerUseEnabled()) return refused("computer-use-off");
    const recipe = options.recipe(owner);
    if (recipe === undefined) return refused("no-provider-configured");
    const loaded = registered(String(recipe.providerId));
    if (loaded === undefined) return refused("no-provider-configured");
    if (!loaded.effective) return refused("provider-disabled");
    if (blocked(String(recipe.providerId))) return refused("release-pending");
    const fits = desktopLeaseFits({
      holdings: projection.list().map((record) => record.lease),
      owner,
      locality: loaded.provider.locality,
    });
    if (!fits) return refused("lease-limit");
    return { status: "admitted", owner, thread, recipe, provider: loaded.provider };
  }

  function refuseCaller(
    actor: EventActor,
    owner: DesktopLeaseOwner,
  ): DesktopLeaseRefusal | undefined {
    if (actor.kind === "system") return refused("not-permitted");
    if (actor.kind === "agent" && String(actor.threadId) !== String(owner.threadId)) {
      return refused("not-permitted");
    }
    if (!options.callerMayOpen(actor, owner)) return refused("not-permitted");
    return undefined;
  }

  const acquire: DesktopLeaseService["acquire"] = async (caller) => {
    await start();
    const first = admitAcquire(caller);
    if (first.status === "refused") return first;
    const status = await driverCall(() => first.provider.status()).catch(() => ({
      status: "not-connected" as const,
    }));
    if (status.status !== "ready") return refused("provider-unavailable");
    const gate = decideDesktopLeaseAcquire({
      executionPolicy: first.thread.executionPolicy,
      billed: first.provider.billed,
      initiator: caller.actor.kind,
    });
    if (gate.kind === "refused") return refused(gate.reason);
    if (gate.kind === "ask") {
      const answer = await options
        .confirm({
          owner: first.owner,
          provider: leasableOf(first.provider),
          asks: gate.asks,
          leaseMinutes: first.recipe.leaseMinutes,
        })
        .catch(() => "declined" as const);
      if (answer !== "approved") return refused("declined");
    }
    // Authority may have changed while a person was deciding, and an answer
    // given for one provider never covers another.
    const admitted = admitAcquire(caller);
    if (admitted.status === "refused") return admitted;
    if (
      String(admitted.provider.id) !== String(first.provider.id) ||
      admitted.provider.billed !== first.provider.billed ||
      admitted.thread.executionPolicy !== first.thread.executionPolicy
    ) {
      return refused("declined");
    }
    if (caller.signal?.aborted === true) return refused("declined");

    const { owner, recipe, provider } = admitted;
    const leaseId = decodeDesktopLeaseId(options.uuid());
    const now = options.now();
    const expiresAt = now + recipe.leaseMinutes * 60_000;
    const requested: DesktopLeaseRequested = {
      leaseId,
      owner,
      providerId: provider.id,
      locality: provider.locality,
      billed: provider.billed,
      hostTag,
      ...(recipe.credentialRef === undefined ? {} : { credentialRef: recipe.credentialRef }),
      network: recipe.network,
      expiresAt: iso(expiresAt),
      maximumExpiresAt: iso(now + recipe.maximumLeaseMinutes * 60_000),
      idleMinutes: recipe.idleMinutes,
    };
    // Journal before create: a crash after this leaves a tagged desktop the
    // next start finds, never an untracked one.
    append(undefined, leaseId, DESKTOP_LEASE_EVENT_NAMES.requested, requested, caller.actor);
    const controller = new AbortController();
    const entry: LiveLease = {
      teardown: teardownPortOf(provider),
      acquiring: controller,
      lastActivityAt: now,
      openTabs: 0,
    };
    live.set(String(leaseId), entry);
    transition(leaseId, "provisioning", caller.actor);
    const signal =
      caller.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, caller.signal]);
    const result = await driverCall(() =>
      provider.acquire({ leaseId, hostTag, recipe, expiresAt: iso(expiresAt), signal }),
    ).catch(() => ({ status: "failed" as const, reason: "The driver threw." }));

    return inOrder(leaseId, async (): Promise<DesktopLeaseAcquireResult> => {
      delete entry.acquiring;
      if (result.status !== "acquired") {
        live.delete(String(leaseId));
        // A lease ended while the provider was creating it records its cause
        // and who asked, as a teardown would; a driver that honours the
        // cancellation otherwise leaves only "cancelled" behind.
        const pending = entry.pendingEnd;
        // Only Octant-authored text reaches the journal, never the driver's reason.
        const lease = transition(
          leaseId,
          result.status === "refused" ? "refused" : "failed",
          caller.actor,
          {
            detail: ACQUIRE_FAILURE_DETAIL[result.status],
            ...(pending === undefined ? {} : { endReason: pending.reason }),
            ...(pending?.requestedBy === undefined ? {} : { requestedBy: pending.requestedBy }),
          },
        );
        await reapStray(teardownPortOf(provider), leaseId);
        return { status: "not-acquired", lease };
      }
      entry.handle = result.handle;
      const pending = entry.pendingEnd;
      if (pending !== undefined) {
        delete entry.pendingEnd;
        await end(leaseId, pending.reason, pending.requestedBy);
        return { status: "not-acquired", lease: read(leaseId).lease };
      }
      const providerExpiresAt =
        result.providerExpiresAt === undefined ? undefined : Date.parse(result.providerExpiresAt);
      if (!desktopProviderExpiryHolds({ billed: provider.billed, expiresAt, providerExpiresAt })) {
        // A billed desktop that could outlive this host is never kept.
        live.delete(String(leaseId));
        const lease = transition(leaseId, "failed", caller.actor, {
          detail: "The provider set no expiry of its own for a billed desktop.",
        });
        await destroyOrphan(`stray:${String(leaseId)}`, {
          teardown: teardownPortOf(provider),
          leaseId,
          handle: result.handle,
        });
        return { status: "not-acquired", lease };
      }
      return { status: "acquired", lease: transition(leaseId, "ready", caller.actor) };
    });
  };

  type Operating = {
    readonly status: "operating";
    readonly record: DesktopLeaseRecord;
    readonly handle: DesktopHandle;
    readonly provider: DesktopProvider;
  };

  /** Every operating command: the lease is the caller's thread's, ready, and still authorized. */
  function admitOperating(
    caller: DesktopLeaseCaller & { readonly leaseId: DesktopLeaseId },
  ): Operating | DesktopLeaseRefusal {
    const record = projection.get(caller.leaseId);
    if (record === undefined) return refused("lease-ended");
    const { mode, threadId } = caller.owner;
    if (mode !== "work" && mode !== "code") return refused("not-leasable-mode");
    const owner: DesktopLeaseOwner = { mode, threadId };
    if (!sameOwner(record.lease.owner, owner)) return refused("leased-by-another-thread");
    const authorityRefusal = refuseCaller(caller.actor, owner);
    if (authorityRefusal !== undefined) return authorityRefusal;
    const handle = live.get(String(caller.leaseId))?.handle;
    if (record.lease.state !== "ready" || handle === undefined) return refused("lease-ended");
    const thread = options.thread(owner);
    if (thread === undefined || !thread.active) return refused("thread-not-active");
    if (!recipeStillCovers(options.recipe(owner), record.lease)) {
      return refused("no-provider-configured");
    }
    const loaded = registered(String(record.lease.providerId));
    if (loaded === undefined || !loaded.effective) return refused("provider-disabled");
    if (!options.computerUseEnabled()) return refused("computer-use-off");
    return { status: "operating", record, handle, provider: loaded.provider };
  }

  const control: DesktopLeaseService["control"] = async (caller) => {
    const admitted = admitOperating(caller);
    if (admitted.status === "refused") return admitted;
    const entry = live.get(String(caller.leaseId));
    if (entry !== undefined) entry.lastActivityAt = options.now();
    const { provider, handle } = admitted;
    const result = await driverCall(() => provider.control(handle, caller.command)).catch(
      (): ComputerControlResult => ({
        kind: "failed",
        reason: "driver-error",
        message: "The desktop provider failed to answer.",
      }),
    );
    return { status: "answered", result };
  };

  /**
   * Extensions run in the lease's order, provider call included. Two people
   * extending at once could otherwise have the provider apply one expiry and
   * the journal record the other, leaving a billed desktop that dies before
   * its lease says. The provider call is bounded like teardown so a provider
   * that never answers cannot hold a release behind it.
   */
  const extend: DesktopLeaseService["extend"] = (caller) =>
    inOrder(caller.leaseId, async (): Promise<DesktopLeaseExtendResult> => {
      const admitted = admitOperating(caller);
      if (admitted.status === "refused") return admitted;
      const { record, provider, handle } = admitted;
      const decision = decideDesktopLeaseExtension({
        actor: caller.actor.kind,
        expiresAt: Date.parse(record.lease.expiresAt),
        maximumExpiresAt: Date.parse(record.lease.maximumExpiresAt),
        byMinutes: caller.byMinutes,
      });
      if (decision.kind === "refused") return refused(decision.reason);
      const reported = await bounded(() => provider.extend(handle, iso(decision.expiresAt)), {
        status: "failed" as const,
        reason: "timed-out",
      });
      // The provider's own clock must have moved, or a host that stops would
      // leave the desktop dying at the old time while the lease says otherwise.
      if (reported.status !== "extended" || Date.parse(reported.expiresAt) < decision.expiresAt) {
        return refused("extension-unconfirmed");
      }
      append(
        record,
        caller.leaseId,
        DESKTOP_LEASE_EVENT_NAMES.extended,
        {
          leaseId: caller.leaseId,
          owner: record.lease.owner,
          providerId: record.lease.providerId,
          previousExpiresAt: record.lease.expiresAt,
          expiresAt: iso(decision.expiresAt),
        },
        caller.actor,
      );
      const entry = live.get(String(caller.leaseId));
      if (entry !== undefined) entry.lastActivityAt = options.now();
      return { status: "extended", lease: read(caller.leaseId).lease };
    });

  const release: DesktopLeaseService["release"] = async (caller) => {
    const record = projection.get(caller.leaseId);
    if (record === undefined) return refused("lease-ended");
    const { mode, threadId } = caller.owner;
    if (mode !== "work" && mode !== "code") return refused("not-leasable-mode");
    if (!sameOwner(record.lease.owner, { mode, threadId })) {
      return refused("leased-by-another-thread");
    }
    const authorityRefusal = refuseCaller(caller.actor, { mode, threadId });
    if (authorityRefusal !== undefined) return authorityRefusal;
    return inOrder(caller.leaseId, () => end(caller.leaseId, "released", caller.actor));
  };

  const retryRelease: DesktopLeaseService["retryRelease"] = async (input) => {
    if (!isPerson(input.actor)) return refused("not-permitted");
    const record = projection.get(input.leaseId);
    if (record === undefined) return refused("lease-ended");
    // Retry may name any thread's lease only because it can only stop spending
    // on a release that was never verified; ending another thread's running
    // desktop is that thread's own Release.
    const state = record.lease.state;
    if (state !== "releasing" && state !== "release-failed") {
      return refused(desktopLeaseHoldsDesktop(state) ? "not-permitted" : "lease-ended");
    }
    return inOrder(input.leaseId, () => end(input.leaseId, "released", input.actor));
  };

  const markTab: DesktopLeaseService["markTab"] = (leaseId, change) => {
    const entry = live.get(String(leaseId));
    if (entry === undefined) return;
    entry.openTabs = Math.max(0, entry.openTabs + (change === "opened" ? 1 : -1));
    entry.lastActivityAt = options.now();
  };

  /** Why a running lease must end now, when something has ended it. */
  function endReasonFor(record: DesktopLeaseRecord): DesktopLeaseEndReason | undefined {
    const lease = record.lease;
    const thread = options.thread(lease.owner);
    if (thread === undefined || !thread.active) return "thread-ended";
    if (!recipeStillCovers(options.recipe(lease.owner), lease)) return "recipe-removed";
    if (registered(String(lease.providerId))?.effective !== true) return "provider-disabled";
    if (!options.computerUseEnabled()) return "computer-use-off";
    if (lease.state !== "ready") return undefined;
    const entry = live.get(String(lease.leaseId));
    return desktopLeaseClockEnds({
      now: options.now(),
      expiresAt: Date.parse(lease.expiresAt),
      idleMinutes: lease.idleMinutes,
      lastActivityAt: entry?.lastActivityAt ?? Date.parse(lease.updatedAt),
      openTabs: entry?.openTabs ?? 0,
    });
  }

  async function sweepOnce(): Promise<void> {
    await start();
    const now = options.now();
    for (const record of projection.list()) {
      const leaseId = record.lease.leaseId;
      if (!desktopLeaseHoldsDesktop(record.lease.state)) continue;
      if (record.lease.state === "release-failed") {
        if (cacheBackoffHolds(live.get(String(leaseId))?.backoff, now)) continue;
        await inOrder(leaseId, () => end(leaseId, "released", undefined));
        continue;
      }
      if (record.lease.state === "releasing") continue;
      const reason = endReasonFor(record);
      if (reason !== undefined) await inOrder(leaseId, () => end(leaseId, reason, undefined));
    }
    for (const [key, orphan] of orphans) {
      if (cacheBackoffHolds(orphan.backoff, now)) continue;
      await destroyOrphan(key, orphan);
    }
  }

  /**
   * One sweep runs at a time. A request that arrives while one runs (a journal
   * commit that archived a thread the running sweep already passed, say) runs
   * one more pass rather than joining the one in flight and being lost.
   */
  const sweep = (): Promise<void> => {
    if (sweeping !== undefined) {
      sweepAgain = true;
      return sweeping;
    }
    const run = async (): Promise<void> => {
      try {
        do {
          sweepAgain = false;
          await sweepOnce();
        } while (sweepAgain);
      } finally {
        sweeping = undefined;
      }
    };
    sweeping = run();
    return sweeping;
  };

  const destination = (): ComputerUseDestinationReport =>
    reportComputerUseDestination({
      platform: options.platform,
      hasScreen: options.hasScreen,
      leasable: options
        .providers()
        .filter((entry) => entry.effective)
        .map((entry) => leasableOf(entry.provider)),
    });

  return { start, destination, acquire, release, retryRelease, extend, control, markTab, sweep };
}
