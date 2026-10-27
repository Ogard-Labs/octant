import {
  AggregateId,
  CorrelationId,
  DESKTOP_ARTIFACT_MAXIMUM_BYTES,
  DESKTOP_LEASE_AGGREGATE_TYPE,
  DESKTOP_LEASE_EVENT_NAMES,
  EventId,
  decodeAggregateVersion,
  decodeDesktopLeaseId,
  decodeDesktopViewId,
  decodeEventActor,
  decodeUtcTimestamp,
  type ComputerControlCommand,
  type ComputerControlResult,
  type DesktopArtifactRefusal,
  type DesktopArtifactSent,
  type DesktopHostTag,
  type DesktopInputEvent,
  type DesktopLease,
  type DesktopLeaseEndReason,
  type DesktopLeaseId,
  type DesktopLeaseOperated,
  type DesktopLeaseOperation,
  type DesktopLeaseOwner,
  type DesktopLeaseRefusal,
  type DesktopLeaseRefusalReason,
  type DesktopLeaseRequested,
  type DesktopLeaseState,
  type DesktopLeaseTransitioned,
  type DesktopPaneRefusal,
  type DesktopPaneStart,
  type DesktopRecipe,
  type DesktopViewId,
  type EventActor,
  type LeasableDesktopProvider,
  type OctantMode,
  type ProviderExecutionPolicy,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  cacheBackoffHolds,
  clampTurnAccessPosture,
  decideDesktopArtifactTransfer,
  decideDesktopLeaseAcquire,
  decideDesktopLeaseExtension,
  desktopInputOperation,
  desktopLeaseClockEnds,
  desktopLeaseFits,
  desktopLeaseHoldsDesktop,
  desktopLeaseTransitionAllowed,
  desktopProviderExpiryHolds,
  extendCacheBackoff,
  type CacheBackoff,
} from "@octant/domain";
import type {
  DesktopFrame,
  DesktopHandle,
  DesktopProvider,
  DesktopScreen,
  DesktopTeardownPort,
} from "@octant/plugin-api/desktop-provider";
import type { ComputerUseOwner } from "@octant/contracts/computer-use-plugin";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import {
  reportComputerUseDestination,
  type ComputerUseDestinationReport,
} from "./computerUseDestination";
import { readDesktopArtifact, type DesktopArtifact } from "./desktopArtifactRead";
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

/** What a person sees before a file is sent: the file, its hash, and where it goes. */
export interface DesktopTransferConfirmation {
  readonly owner: DesktopLeaseOwner;
  readonly leaseId: DesktopLeaseId;
  readonly provider: LeasableDesktopProvider;
  /** `off-machine` asks a person in every posture; `in-thread` follows the thread's approvals. */
  readonly asks: "in-thread" | "off-machine";
  readonly artifact: DesktopArtifact;
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
  /**
   * Whether a person's window or device, or an agent's turn, may open the
   * thread. A person's request names the authenticated window or device scope
   * it came from; one that names none may not.
   */
  readonly callerMayOpen: (
    actor: EventActor,
    owner: DesktopLeaseOwner,
    scopeId: string | undefined,
  ) => boolean;
  readonly computerUseEnabled: () => boolean;
  readonly confirm: (request: DesktopLeaseConfirmation) => Promise<"approved" | "declined">;
  /** The thread's bound root now: its Code checkout, or its Work Project root. */
  readonly threadRoot: (owner: DesktopLeaseOwner) => Promise<string | undefined>;
  readonly confirmTransfer: (
    request: DesktopTransferConfirmation,
  ) => Promise<"approved" | "declined">;
  readonly systemActor: EventActor;
  readonly now: () => number;
  readonly uuid: () => string;
  /** How long one teardown call may take before it counts as failed. */
  readonly teardownTimeoutMs?: number;
  /** How long a Desktop tab's view lives with no frame read and no input. */
  readonly viewIdleMs?: number;
}

export interface DesktopLeaseCaller {
  readonly owner: { readonly mode: OctantMode; readonly threadId: string };
  readonly actor: EventActor;
  /** The authenticated window or paired device a person's request came from. */
  readonly scopeId?: string;
}

/** What a person's Desktop tab shows for one thread. */
export interface DesktopLeaseOverview {
  readonly status: "overview";
  /** Leases that may still hold a desktop, oldest first, then the most recent ended one. */
  readonly leases: ReadonlyArray<DesktopLease>;
  readonly providers: ReadonlyArray<LeasableDesktopProvider>;
  readonly start: DesktopPaneStart;
}

export type DesktopViewOpenResult =
  | { readonly status: "viewing"; readonly viewId: DesktopViewId }
  | DesktopPaneRefusal;

export type DesktopViewFrameResult =
  | { readonly status: "frame"; readonly frame: DesktopFrame }
  /** The desktop answered no frame the host would pass on; the view stays open. */
  | { readonly status: "no-frame" }
  | DesktopPaneRefusal;

export type DesktopViewInputResult =
  | { readonly status: "delivered" }
  /** Journaled, but the desktop did not take it. */
  | { readonly status: "not-delivered" }
  | DesktopPaneRefusal;

type DesktopViewCaller = DesktopLeaseCaller & {
  readonly leaseId: DesktopLeaseId;
  readonly viewId: DesktopViewId;
};

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

export type DesktopLeaseTransferResult =
  | { readonly status: "delivered"; readonly artifact: DesktopArtifact }
  /** Journaled as sent, but the driver did not confirm the desktop has it. */
  | { readonly status: "not-delivered"; readonly artifact: DesktopArtifact }
  | DesktopLeaseRefusal
  | DesktopArtifactRefusal;

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
  /**
   * Sends one checkout-relative file into the lease's inbox. The bytes the
   * host hashed, showed, and journaled are the bytes the driver receives.
   */
  readonly transfer: (
    caller: DesktopLeaseCaller & {
      readonly leaseId: DesktopLeaseId;
      readonly path: string;
      /**
       * Where this caller's confirmation is asked, when it brings its own: an
       * agent's turn asks in its thread. Otherwise `confirmTransfer` asks.
       */
      readonly confirm?: (request: DesktopTransferConfirmation) => Promise<"approved" | "declined">;
      /**
       * An agent's turn as it runs now. A turn may sit below its thread's
       * posture, and a thread that read outside content no longer lets Full
       * access carry the agent's transfer; either only adds a question.
       */
      readonly turn?: {
        readonly executionPolicy: ProviderExecutionPolicy;
        readonly externalContentIngested: boolean;
      };
    },
  ) => Promise<DesktopLeaseTransferResult>;
  /** A Desktop tab opened or closed on a lease; an open tab holds idle release off. */
  readonly markTab: (leaseId: DesktopLeaseId, change: "opened" | "closed") => void;
  /** The thread's leases and whether it could start one now, for a person's Desktop tab. */
  readonly overview: (
    caller: DesktopLeaseCaller,
  ) => Promise<DesktopLeaseOverview | DesktopLeaseRefusal>;
  /**
   * Opens a person's view of a running lease. Only a person's window or
   * device opens one, and only it may read frames or send input through it.
   */
  readonly openView: (
    caller: DesktopLeaseCaller & { readonly leaseId: DesktopLeaseId },
  ) => Promise<DesktopViewOpenResult>;
  /** One frame for a view. Frames are never journaled or stored. */
  readonly frame: (caller: DesktopViewCaller) => Promise<DesktopViewFrameResult>;
  /** A person's input through a view: journaled as theirs before the driver gets it, and never asked. */
  readonly input: (
    caller: DesktopViewCaller & { readonly event: DesktopInputEvent },
  ) => Promise<DesktopViewInputResult>;
  readonly closeView: (
    caller: DesktopViewCaller,
  ) => Promise<{ readonly status: "view-closed" } | DesktopPaneRefusal>;
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

/**
 * A person's view of one lease: host memory only. The screen is the one the
 * driver served when it was last resolved; a driver resolved afresh serves a
 * fresh screen.
 */
interface DesktopView {
  readonly viewId: string;
  readonly leaseId: DesktopLeaseId;
  /** The person and the window or device that opened it; no one else reads through it. */
  readonly holder: string;
  screen?: { readonly provider: DesktopProvider; readonly screen: DesktopScreen };
  lastSeenAt: number;
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
/**
 * A view nobody reads for this long is closed, so a window that went away
 * without closing its tab does not hold idle release off for good. A tab that
 * is on screen reads frames far more often than this.
 */
const DEFAULT_VIEW_IDLE_MS = 30_000;
/** Open views one lease may hold: two leases' worth of windows and a phone, with room to spare. */
const MAX_VIEWS_PER_LEASE = 4;
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
const DRIVER_DID_NOT_ANSWER: ComputerControlResult = {
  kind: "failed",
  reason: "driver-error",
  message: "The desktop provider failed to answer.",
};

/** The input a command sends, or undefined for one that only reads the screen. */
function operationOf(command: ComputerControlCommand): DesktopLeaseOperation | undefined {
  switch (command.operation) {
    case "launch":
    case "click":
    case "type":
    case "press":
    case "scroll":
      return command.operation;
    case "apps":
    case "windows":
    case "observe":
    case "stop":
      return undefined;
  }
}

const isPerson = (actor: EventActor): boolean =>
  actor.kind === "local-user" || actor.kind === "remote-device";

/** Who holds a view: the person's kind and the scope they asked from. */
function viewHolder(caller: DesktopLeaseCaller): string | undefined {
  if (!isPerson(caller.actor) || caller.scopeId === undefined) return undefined;
  const device = caller.actor.kind === "remote-device" ? String(caller.actor.deviceId) : "";
  return `${caller.actor.kind}:${device}:${caller.scopeId}`;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Whether a frame a driver returned may be passed on: no larger than the
 * recipe's screen, in bytes or in pixels, and the image it says it is. The
 * image's own header must name the size the driver reported: a PNG's IHDR, or
 * a JPEG's first frame header, since a few kilobytes of JPEG can declare a
 * picture far larger than the screen. Nothing here decodes pixels; the bounds
 * come first so nothing later does either on a frame that fails them. A
 * driver is untrusted code, and a renderer is told the media type it may
 * decode, so a type outside the two never passes.
 */
export function desktopFrameFits(frame: DesktopFrame, screen: DesktopRecipe["screen"]): boolean {
  const { width, height, bytes } = frame;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return false;
  if (width < 1 || height < 1 || width > screen.width || height > screen.height) return false;
  if (bytes.byteLength > screen.width * screen.height * 4 + screen.height + 1_048_576) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (frame.mediaType === "image/jpeg") {
    const size = jpegFrameSize(bytes, view);
    return size !== undefined && size.width === width && size.height === height;
  }
  if (frame.mediaType !== "image/png") return false;
  if (bytes.byteLength < 24 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return false;
  }
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return false;
  return view.getUint32(16) === width && view.getUint32(20) === height;
}

/**
 * The size a JPEG's first start-of-frame segment names, walking the marker
 * segments before it, or undefined when the bytes reach scan data or end
 * before one. DHT (C4), JPG (C8), and DAC (CC) share the SOF range but are
 * not frame headers.
 */
function jpegFrameSize(
  bytes: Uint8Array,
  view: DataView,
): { readonly width: number; readonly height: number } | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = view.getUint16(offset + 2);
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 7 || offset + 9 > bytes.byteLength) return undefined;
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}
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
  const viewIdleMs = options.viewIdleMs ?? DEFAULT_VIEW_IDLE_MS;
  const live = new Map<string, LiveLease>();
  const orphans = new Map<string, Orphan>();
  const serial = new Map<string, Promise<unknown>>();
  /** Leases with a transfer between its read and its delivery. */
  const transferring = new Set<string>();
  const views = new Map<string, DesktopView>();
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
    // A lease that is ending shows nothing more to anyone.
    closeViewsOf(leaseId);
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
    const authorityRefusal = refuseCaller(caller, owner);
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
    caller: Pick<DesktopLeaseCaller, "actor" | "scopeId">,
    owner: DesktopLeaseOwner,
  ): DesktopLeaseRefusal | undefined {
    const { actor } = caller;
    if (actor.kind === "system") return refused("not-permitted");
    if (actor.kind === "agent" && String(actor.threadId) !== String(owner.threadId)) {
      return refused("not-permitted");
    }
    if (!options.callerMayOpen(actor, owner, caller.scopeId)) return refused("not-permitted");
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
    readonly thread: DesktopLeaseThread;
    readonly recipe: DesktopRecipe;
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
    const authorityRefusal = refuseCaller(caller, owner);
    if (authorityRefusal !== undefined) return authorityRefusal;
    const handle = live.get(String(caller.leaseId))?.handle;
    if (record.lease.state !== "ready" || handle === undefined) return refused("lease-ended");
    const thread = options.thread(owner);
    if (thread === undefined || !thread.active) return refused("thread-not-active");
    const recipe = options.recipe(owner);
    if (recipe === undefined || !recipeStillCovers(recipe, record.lease)) {
      return refused("no-provider-configured");
    }
    const loaded = registered(String(record.lease.providerId));
    if (loaded === undefined || !loaded.effective) return refused("provider-disabled");
    if (!options.computerUseEnabled()) return refused("computer-use-off");
    return { status: "operating", record, handle, provider: loaded.provider, thread, recipe };
  }

  /**
   * Commands run in the lease's order, so a release never races one, and are
   * bounded like a teardown call. An input is journaled with the caller as
   * actor before the driver gets it, so a command cut off midway is still on
   * record; reading the screen is not journaled.
   */
  const control: DesktopLeaseService["control"] = (caller) =>
    inOrder(caller.leaseId, async (): Promise<DesktopLeaseControlResult> => {
      const admitted = admitOperating(caller);
      if (admitted.status === "refused") return admitted;
      const { record, provider, handle } = admitted;
      const operation = operationOf(caller.command);
      if (operation !== undefined) {
        const operated: DesktopLeaseOperated = {
          leaseId: caller.leaseId,
          owner: record.lease.owner,
          providerId: record.lease.providerId,
          operation,
          ...(caller.command.operation === "launch" ? { appId: caller.command.appId } : {}),
        };
        append(record, caller.leaseId, DESKTOP_LEASE_EVENT_NAMES.operated, operated, caller.actor);
      }
      const entry = live.get(String(caller.leaseId));
      if (entry !== undefined) entry.lastActivityAt = options.now();
      const result = await bounded(
        () => provider.control(handle, caller.command),
        DRIVER_DID_NOT_ANSWER,
      );
      return { status: "answered", result };
    });

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

  /**
   * The file is read and hashed once, before anyone is asked, and those bytes
   * are what the person approves, what the journal records, and what the
   * driver receives; a file changed while a person decides is not re-read.
   * Authority, posture, provider, and root are checked again after the answer,
   * in the lease's order. The send itself runs there too and is bounded like a
   * teardown call, so a driver that never answers cannot hold a release behind
   * it. A lease holds one transfer's bytes at a time: each waits on a person
   * for as long as they take, so otherwise concurrent calls would each hold up
   * to the size limit.
   */
  const transfer: DesktopLeaseService["transfer"] = async (caller) => {
    const key = String(caller.leaseId);
    if (transferring.has(key)) return { status: "refused", reason: "transfer-in-progress" };
    transferring.add(key);
    try {
      return await transferHeld(caller);
    } finally {
      transferring.delete(key);
    }
  };

  async function transferHeld(
    caller: Parameters<DesktopLeaseService["transfer"]>[0],
  ): Promise<DesktopLeaseTransferResult> {
    const first = admitOperating(caller);
    if (first.status === "refused") return first;
    const gate = decideDesktopArtifactTransfer({
      executionPolicy: clampTurnAccessPosture({
        ...(caller.turn === undefined ? {} : { requested: caller.turn.executionPolicy }),
        thread: first.thread.executionPolicy,
      }),
      locality: first.provider.locality,
      initiator: caller.actor.kind,
      externalContentIngested: caller.turn?.externalContentIngested === true,
    });
    if (gate.kind === "refused") return refused(gate.reason);
    const owner = first.record.lease.owner;
    const root = await options.threadRoot(owner).catch(() => undefined);
    if (root === undefined) return { status: "refused", reason: "no-root" };
    const read = await readDesktopArtifact({
      root,
      path: caller.path,
      maximumBytes: DESKTOP_ARTIFACT_MAXIMUM_BYTES,
    });
    if (read.status === "refused") return read;
    const { artifact, bytes } = read;
    if (gate.kind === "ask") {
      const confirm = caller.confirm ?? options.confirmTransfer;
      const answer = await driverCall(() =>
        confirm({
          owner,
          leaseId: caller.leaseId,
          provider: leasableOf(first.provider),
          asks: gate.asks,
          artifact,
        }),
      ).catch(() => "declined" as const);
      if (answer !== "approved") return refused("declined");
    }
    return inOrder(caller.leaseId, async (): Promise<DesktopLeaseTransferResult> => {
      const rootNow = await options.threadRoot(owner).catch(() => undefined);
      const admitted = admitOperating(caller);
      if (admitted.status === "refused") return admitted;
      // An answer given for one provider, posture, or checkout never covers another.
      if (
        String(admitted.provider.id) !== String(first.provider.id) ||
        admitted.provider.locality !== first.provider.locality ||
        admitted.thread.executionPolicy !== first.thread.executionPolicy ||
        rootNow !== root
      ) {
        return refused("declined");
      }
      const sent: DesktopArtifactSent = {
        leaseId: caller.leaseId,
        owner,
        providerId: admitted.record.lease.providerId,
        ...artifact,
      };
      // Journaled before the bytes leave, so a send cut off midway is on record.
      append(
        admitted.record,
        caller.leaseId,
        DESKTOP_LEASE_EVENT_NAMES.artifactSent,
        sent,
        caller.actor,
      );
      const entry = live.get(String(caller.leaseId));
      if (entry !== undefined) entry.lastActivityAt = options.now();
      const { provider, handle } = admitted;
      const delivered = await bounded(() => provider.deliver(handle, artifact.name, bytes), {
        status: "failed" as const,
        reason: "timed-out",
      });
      return delivered.status === "delivered"
        ? { status: "delivered", artifact }
        : { status: "not-delivered", artifact };
    });
  }

  const release: DesktopLeaseService["release"] = async (caller) => {
    const record = projection.get(caller.leaseId);
    if (record === undefined) return refused("lease-ended");
    const { mode, threadId } = caller.owner;
    if (mode !== "work" && mode !== "code") return refused("not-leasable-mode");
    if (!sameOwner(record.lease.owner, { mode, threadId })) {
      return refused("leased-by-another-thread");
    }
    const authorityRefusal = refuseCaller(caller, { mode, threadId });
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

  function closeView(viewId: string, view: DesktopView): void {
    views.delete(viewId);
    markTab(view.leaseId, "closed");
    const screen = view.screen?.screen;
    if (screen !== undefined) void driverCall(() => screen.close()).catch(() => undefined);
  }

  function closeViewsOf(leaseId: DesktopLeaseId): void {
    for (const [viewId, view] of views) {
      if (String(view.leaseId) === String(leaseId)) closeView(viewId, view);
    }
  }

  const overview: DesktopLeaseService["overview"] = async (caller) => {
    await start();
    const { mode, threadId } = caller.owner;
    if (mode !== "work" && mode !== "code") return refused("not-leasable-mode");
    const owner: DesktopLeaseOwner = { mode, threadId };
    const authorityRefusal = refuseCaller(caller, owner);
    if (authorityRefusal !== undefined) return authorityRefusal;
    const leases = projection
      .list()
      .map((record) => record.lease)
      .filter((lease) => sameOwner(lease.owner, owner));
    const holding = leases
      .filter((lease) => desktopLeaseHoldsDesktop(lease.state))
      .sort((left, right) => Date.parse(left.requestedAt) - Date.parse(right.requestedAt));
    const lastEnded = leases
      .filter((lease) => !desktopLeaseHoldsDesktop(lease.state))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 1);
    return {
      status: "overview",
      leases: [...holding, ...lastEnded],
      providers: options.providers().map((entry) => leasableOf(entry.provider)),
      start: startFor(caller),
    };
  };

  /**
   * Every refusal an acquire would meet without asking the provider, the Plan
   * gate included, so a tab never offers a Start that would only refuse once
   * pressed. Acquire still checks each of them itself.
   */
  function startFor(caller: DesktopLeaseCaller): DesktopPaneStart {
    const admitted = admitAcquire(caller);
    if (admitted.status === "refused") return admitted;
    const gate = decideDesktopLeaseAcquire({
      executionPolicy: admitted.thread.executionPolicy,
      billed: admitted.provider.billed,
      initiator: caller.actor.kind,
    });
    if (gate.kind === "refused") return refused(gate.reason);
    return { status: "available", provider: leasableOf(admitted.provider) };
  }

  /** A view the caller holds on this lease, with the lease still operable by them. */
  function admitView(
    caller: DesktopViewCaller,
  ):
    | { readonly status: "viewing"; readonly view: DesktopView; readonly operating: Operating }
    | DesktopPaneRefusal {
    const view = views.get(String(caller.viewId));
    const holder = viewHolder(caller);
    if (
      view === undefined ||
      holder === undefined ||
      view.holder !== holder ||
      String(view.leaseId) !== String(caller.leaseId)
    ) {
      return { status: "refused", reason: "view-ended" };
    }
    const operating = admitOperating(caller);
    if (operating.status === "refused") return operating;
    view.lastSeenAt = options.now();
    return { status: "viewing", view, operating };
  }

  /** The view's screen from the driver resolved now; a different driver serves a fresh one. */
  async function screenOf(
    view: DesktopView,
    operating: Operating,
  ): Promise<DesktopScreen | undefined> {
    if (view.screen?.provider === operating.provider) return view.screen.screen;
    const opened = await bounded(() => operating.provider.screen(operating.handle), {
      status: "failed" as const,
      reason: "timed-out",
    });
    if (opened.status !== "ready") return undefined;
    // The view may have closed while the driver answered.
    if (views.get(view.viewId) !== view) {
      void driverCall(() => opened.screen.close()).catch(() => undefined);
      return undefined;
    }
    const previous = view.screen?.screen;
    if (previous !== undefined) void driverCall(() => previous.close()).catch(() => undefined);
    view.screen = { provider: operating.provider, screen: opened.screen };
    return opened.screen;
  }

  const openView: DesktopLeaseService["openView"] = async (caller) => {
    const holder = viewHolder(caller);
    if (holder === undefined) return refused("not-permitted");
    const operating = admitOperating(caller);
    if (operating.status === "refused") return operating;
    const held = [...views.values()].filter(
      (view) => String(view.leaseId) === String(caller.leaseId),
    ).length;
    if (held >= MAX_VIEWS_PER_LEASE) return { status: "refused", reason: "view-limit" };
    const viewId = decodeDesktopViewId(options.uuid());
    const view: DesktopView = {
      viewId: String(viewId),
      leaseId: caller.leaseId,
      holder,
      lastSeenAt: options.now(),
    };
    views.set(String(viewId), view);
    markTab(caller.leaseId, "opened");
    if ((await screenOf(view, operating)) === undefined) {
      if (views.get(String(viewId)) === view) closeView(String(viewId), view);
      return refused("provider-unavailable");
    }
    return { status: "viewing", viewId };
  };

  const frame: DesktopLeaseService["frame"] = async (caller) => {
    const admitted = admitView(caller);
    if (admitted.status === "refused") return admitted;
    const screen = await screenOf(admitted.view, admitted.operating);
    if (screen === undefined) return { status: "no-frame" };
    const answered = await bounded(() => screen.frame(), {
      status: "failed" as const,
      reason: "timed-out",
    });
    if (
      answered.status !== "frame" ||
      !desktopFrameFits(answered.frame, admitted.operating.recipe.screen)
    ) {
      return { status: "no-frame" };
    }
    return { status: "frame", frame: answered.frame };
  };

  /**
   * A person's input runs in the lease's order like an agent's command, and
   * is journaled with the person as actor before the driver gets it. Nothing
   * is asked: the person is not an agent, and what they do in the tab is
   * their own act.
   */
  const input: DesktopLeaseService["input"] = (caller) =>
    inOrder(caller.leaseId, async (): Promise<DesktopViewInputResult> => {
      const admitted = admitView(caller);
      if (admitted.status === "refused") return admitted;
      const { record } = admitted.operating;
      const operation = desktopInputOperation(caller.event);
      if (operation !== undefined) {
        const operated: DesktopLeaseOperated = {
          leaseId: caller.leaseId,
          owner: record.lease.owner,
          providerId: record.lease.providerId,
          operation,
        };
        append(record, caller.leaseId, DESKTOP_LEASE_EVENT_NAMES.operated, operated, caller.actor);
      }
      const entry = live.get(String(caller.leaseId));
      if (entry !== undefined) entry.lastActivityAt = options.now();
      const screen = await screenOf(admitted.view, admitted.operating);
      if (screen === undefined) return { status: "not-delivered" };
      const delivered = await bounded(() => screen.input(caller.event), {
        status: "failed" as const,
        reason: "timed-out",
      });
      return delivered.status === "delivered"
        ? { status: "delivered" }
        : { status: "not-delivered" };
    });

  const closeViewByCaller: DesktopLeaseService["closeView"] = async (caller) => {
    const view = views.get(String(caller.viewId));
    const holder = viewHolder(caller);
    if (
      view === undefined ||
      holder === undefined ||
      view.holder !== holder ||
      String(view.leaseId) !== String(caller.leaseId)
    ) {
      return { status: "refused", reason: "view-ended" };
    }
    closeView(String(caller.viewId), view);
    return { status: "view-closed" };
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
    for (const [viewId, view] of views) {
      if (now - view.lastSeenAt >= viewIdleMs) closeView(viewId, view);
    }
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

  return {
    start,
    destination,
    acquire,
    release,
    retryRelease,
    extend,
    control,
    transfer,
    markTab,
    overview,
    openView,
    frame,
    input,
    closeView: closeViewByCaller,
    sweep,
  };
}

/**
 * The host's path to a thread's disposable desktops for one agent turn's
 * `octant_computer`. Approvals, sensitive-field protection, and taint stay
 * with the tool binding; this only acts as the owner's agent.
 */
export interface LeasedComputerUsePort {
  /** Whether a send may bind the owner's lease: its own thread's, and running. */
  readonly bindable: (owner: ComputerUseOwner) => boolean;
  readonly control: (
    owner: ComputerUseOwner,
    command: ComputerControlCommand,
  ) => Promise<ComputerControlResult>;
  readonly sendFile: (
    owner: ComputerUseOwner,
    path: string,
    confirm: (request: DesktopTransferConfirmation) => Promise<"approved" | "declined">,
    /** Whether the owner's thread has read outside content, which stops Full access carrying the send. */
    externalContentIngested: boolean,
  ) => Promise<ComputerControlResult>;
}

const LEASE_REFUSAL_MESSAGE =
  "The host refused this on the thread's disposable desktop; the reason names why.";

/**
 * Every call goes through the lease service as the owner's agent, so the
 * lease's authority is checked again each time and what the agent sends is
 * journaled as `agent`.
 */
export function createLeasedComputerUsePort(
  service: Pick<DesktopLeaseService, "control" | "transfer">,
  projection: Pick<DesktopLeaseProjection, "get">,
): LeasedComputerUsePort {
  const callerOf = (owner: ComputerUseOwner) => {
    if (owner.leaseId === undefined) return undefined;
    return {
      owner: { mode: owner.mode, threadId: owner.threadId },
      actor: decodeEventActor({
        kind: "agent",
        actorId: owner.providerInstanceId,
        providerInstanceId: owner.providerInstanceId,
        threadId: owner.threadId,
      }),
      leaseId: owner.leaseId,
    };
  };
  const unbound: ComputerControlResult = {
    kind: "refused",
    reason: "no-destination",
    message: "This turn is not bound to a disposable desktop.",
  };
  return {
    bindable: (owner) => {
      if (owner.leaseId === undefined) return false;
      const lease = projection.get(owner.leaseId)?.lease;
      return (
        lease !== undefined &&
        lease.state === "ready" &&
        lease.owner.mode === owner.mode &&
        String(lease.owner.threadId) === String(owner.threadId)
      );
    },
    control: async (owner, command) => {
      const caller = callerOf(owner);
      if (caller === undefined) return unbound;
      const answered = await service.control({ ...caller, command });
      return answered.status === "answered"
        ? answered.result
        : { kind: "refused", reason: answered.reason, message: LEASE_REFUSAL_MESSAGE };
    },
    sendFile: async (owner, path, confirm, externalContentIngested) => {
      const caller = callerOf(owner);
      if (caller === undefined) return unbound;
      const sent = await service.transfer({
        ...caller,
        path,
        confirm,
        turn: { executionPolicy: owner.executionPolicy, externalContentIngested },
      });
      switch (sent.status) {
        case "delivered":
          return {
            kind: "sent",
            name: sent.artifact.name,
            size: sent.artifact.size,
            sha256: sent.artifact.sha256,
          };
        case "not-delivered":
          return {
            kind: "failed",
            reason: "not-delivered",
            message: "The transfer was recorded, but the desktop did not confirm it has the file.",
          };
        case "refused":
          return { kind: "refused", reason: sent.reason, message: LEASE_REFUSAL_MESSAGE };
      }
    },
  };
}
