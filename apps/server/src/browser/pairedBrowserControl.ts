import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { UtcTimestamp, type BrowserContextId, type BrowserThreadId } from "@octant/contracts";
import {
  readDeviceApprovedByPerson,
  readDeviceRegistration,
  readRemoteSessionInvalidation,
} from "../persistence/remoteAccessProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  MAX_PAIRED_BROWSER_FILE_BYTES,
  MAX_PAIRED_BROWSER_FPS,
  PAIRED_BROWSER_IDLE_MS,
  PAIRED_BROWSER_STREAM_DISCONNECT_MS,
  decodePairedBrowserLeaseId,
  decodePairedBrowserStreamEvent,
  type PairedBrowserChooserId,
  type PairedBrowserEndReason,
  type PairedBrowserInput,
  type PairedBrowserLeaseId,
  type PairedBrowserNativeResult,
  type PairedBrowserNativeTarget,
  type PairedBrowserRequest,
  type PairedBrowserResponse,
  type PairedBrowserStreamEvent,
  type PairedBrowserTarget,
  type PairedBrowserWithheldReason,
} from "@octant/contracts/paired-browser-control";
import {
  countPairedBrowserTypedChars,
  decidePairedBrowserPrincipal,
  decidePairedBrowserTakeOver,
  evaluatePairedBrowserInputRate,
  evaluatePairedBrowserSequence,
  isForbiddenPairedBrowserKey,
  type PrincipalKind,
} from "@octant/domain";
import { Schema } from "effect";
import type { PairedBrowserJournalFact } from "./pairedBrowserJournal";

export interface PairedBrowserActor {
  readonly principalKind: PrincipalKind;
  readonly isAgentGrant?: boolean;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly sessionId: string;
  readonly credentialGeneration: number;
  readonly current: () => boolean;
}

export interface PairedBrowserInspectedTarget {
  readonly target: PairedBrowserTarget;
  readonly origin: string;
  readonly nativeTarget: PairedBrowserNativeTarget;
  readonly authorityCurrent: boolean;
}

export interface PairedBrowserHost {
  readonly inspectThread: (
    threadId: BrowserThreadId,
    signal?: AbortSignal,
  ) => Promise<PairedBrowserInspectedTarget | undefined>;
  readonly authorityCurrent: (target: PairedBrowserTarget) => boolean;
  readonly claim: (input: {
    readonly target: PairedBrowserTarget;
    readonly nativeTarget: PairedBrowserNativeTarget;
    readonly leaseId: PairedBrowserLeaseId;
    readonly deviceId: string;
    readonly deviceName: string;
    readonly expiresAt: UtcTimestamp;
  }) => Promise<boolean>;
  readonly frame: (
    target: PairedBrowserTarget,
    leaseId: PairedBrowserLeaseId,
    signal?: AbortSignal,
  ) => Promise<PairedBrowserNativeResult>;
  readonly input: (
    target: PairedBrowserTarget,
    leaseId: PairedBrowserLeaseId,
    events: ReadonlyArray<PairedBrowserInput>,
    signal?: AbortSignal,
  ) => Promise<PairedBrowserNativeResult>;
  readonly fileChoice: (
    target: PairedBrowserTarget,
    leaseId: PairedBrowserLeaseId,
    chooserId: PairedBrowserChooserId,
    paths: ReadonlyArray<string>,
    signal?: AbortSignal,
  ) => Promise<PairedBrowserNativeResult>;
  /**
   * `hand-back` releases the lease and page hold if the lease is still current;
   * `revoke` ends only the remote lease and leaves an ordinary take-over hold.
   */
  readonly release: (
    target: PairedBrowserTarget,
    leaseId: PairedBrowserLeaseId,
    disposition: "revoke" | "hand-back",
  ) => Promise<{ readonly status: "released" | "refused"; readonly reason?: string }>;
}

interface StreamSink {
  readonly push: (event: PairedBrowserStreamEvent) => void;
  readonly close: () => void;
}

interface RateSample {
  readonly at: number;
  readonly count: number;
}

interface ActivePairedLease {
  readonly id: PairedBrowserLeaseId;
  readonly target: PairedBrowserTarget;
  readonly origin: string;
  readonly actor: PairedBrowserActor;
  readonly abort: AbortController;
  readonly eventSamples: Array<RateSample>;
  readonly charSamples: Array<RateSample>;
  readonly announcedChoosers: Set<string>;
  expiresAt: UtcTimestamp;
  lastAcceptedSequence: number;
  eventCount: number;
  frameCount: number;
  lastWithheldReason: PairedBrowserWithheldReason | undefined;
  stream: StreamSink | undefined;
  hostBusy: boolean;
  hostChain: Promise<void>;
  disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  ended: boolean;
}

export interface PairedBrowserControlOptions {
  readonly host: PairedBrowserHost;
  readonly now: () => number;
  readonly timestamp: () => string;
  readonly uuid: () => string;
  readonly journal: (fact: PairedBrowserJournalFact) => void;
  readonly frameIntervalMs?: number;
  readonly disconnectTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly onReclaim?: (listener: (contextId: BrowserContextId) => void) => () => void;
  readonly onPageEnded?: (listener: (contextId: BrowserContextId) => void) => () => void;
  readonly onSignInSettled?: (listener: (contextId: BrowserContextId) => void) => () => void;
  readonly onAuthorityChange?: (listener: () => void) => () => void;
}

export type PairedBrowserStreamOpenResult =
  | { readonly status: "stream"; readonly stream: ReadableStream<Uint8Array> }
  | Extract<PairedBrowserResponse, { readonly status: "refused" }>;

const encoder = new TextEncoder();
const MAX_PAIRED_STAGED_UPLOADS = 16;

export function isPairedDeviceSessionCurrent(
  connection: SqliteConnection,
  principal: {
    readonly deviceId: unknown;
    readonly sessionId: unknown;
    readonly credentialGeneration: number;
  },
  nowMs: number,
): boolean {
  const deviceId = String(principal.deviceId);
  const registration = readDeviceRegistration(connection, deviceId);
  if (
    registration === undefined ||
    registration.state !== "active" ||
    registration.revokedAt !== null ||
    (registration.expiresAt !== null && Date.parse(registration.expiresAt) <= nowMs)
  ) {
    return false;
  }
  if (registration.credentialGeneration !== principal.credentialGeneration) return false;
  if (!readDeviceApprovedByPerson(connection, deviceId)) return false;

  const sessionIdDigest = createHash("sha256")
    .update(String(principal.sessionId), "utf8")
    .digest("hex");
  if (readRemoteSessionInvalidation(connection, sessionIdDigest) !== undefined) {
    return false;
  }

  const session = connection
    .prepare(
      `SELECT device_id, credential_generation, idle_expires_at, absolute_expires_at, state
       FROM remote_session_store
       WHERE session_id_digest = ?`,
    )
    .get(sessionIdDigest) as
    | {
        readonly device_id: string;
        readonly credential_generation: number;
        readonly idle_expires_at: number;
        readonly absolute_expires_at: number;
        readonly state: string;
      }
    | undefined;
  if (
    session === undefined ||
    session.state !== "active" ||
    session.device_id !== deviceId ||
    session.credential_generation !== principal.credentialGeneration ||
    session.idle_expires_at <= nowMs ||
    session.absolute_expires_at <= nowMs
  ) {
    return false;
  }
  return true;
}

export class PairedBrowserControlService {
  readonly #options: PairedBrowserControlOptions;
  readonly #frameIntervalMs: number;
  readonly #disconnectTimeoutMs: number;
  readonly #idleTimeoutMs: number;
  readonly #leases = new Map<string, ActivePairedLease>();
  readonly #byContext = new Map<string, PairedBrowserLeaseId>();
  readonly #byDevice = new Map<string, PairedBrowserLeaseId>();
  readonly #claimingDevices = new Set<string>();
  readonly #claimingContexts = new Set<string>();
  readonly #stagedUploads = new Map<string, Array<() => Promise<void>>>();
  readonly #unsubscribes: Array<() => void> = [];
  #closed = false;

  constructor(options: PairedBrowserControlOptions) {
    this.#options = options;
    this.#frameIntervalMs = options.frameIntervalMs ?? Math.ceil(1_000 / MAX_PAIRED_BROWSER_FPS);
    this.#disconnectTimeoutMs = options.disconnectTimeoutMs ?? PAIRED_BROWSER_STREAM_DISCONNECT_MS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? PAIRED_BROWSER_IDLE_MS;
    if (options.onReclaim !== undefined) {
      this.#unsubscribes.push(
        options.onReclaim((contextId) => {
          void this.reclaimLocally(contextId);
        }),
      );
    }
    if (options.onPageEnded !== undefined) {
      this.#unsubscribes.push(
        options.onPageEnded((contextId) => {
          void this.pageEnded(contextId);
        }),
      );
    }
    if (options.onSignInSettled !== undefined) {
      this.#unsubscribes.push(
        options.onSignInSettled((contextId) => {
          void this.signInSettled(contextId);
        }),
      );
    }
    if (options.onAuthorityChange !== undefined) {
      this.#unsubscribes.push(options.onAuthorityChange(() => this.revalidateAuthority()));
    }
  }

  async takeOver(
    actor: PairedBrowserActor,
    threadId: BrowserThreadId,
    signal?: AbortSignal,
  ): Promise<PairedBrowserResponse> {
    const principal = decidePairedBrowserPrincipal(actor);
    if (principal.status === "refused") return principal;
    if (this.#closed || signal?.aborted || !actor.current()) {
      return { status: "refused", reason: "authority-ended" };
    }
    const inspected = await this.#options.host.inspectThread(threadId, signal);
    if (this.#closed || signal?.aborted || !actor.current()) {
      return { status: "refused", reason: "authority-ended" };
    }
    const contextKey = inspected === undefined ? undefined : String(inspected.target.contextId);
    const existingForContext =
      contextKey === undefined ? undefined : this.#byContext.get(contextKey);
    const existingForDevice = this.#byDevice.get(actor.deviceId);
    // Re-asking take-over on the exact page this same device already holds returns its live lease.
    if (
      inspected !== undefined &&
      existingForContext !== undefined &&
      existingForDevice === existingForContext
    ) {
      const held = this.#leases.get(existingForContext);
      if (held !== undefined && this.#matchesActor(held, actor) && this.#leaseValid(held)) {
        return {
          status: "held",
          leaseId: held.id,
          expiresAt: held.expiresAt,
          target: held.target,
        };
      }
    }
    const admission = decidePairedBrowserTakeOver({
      principalKind: actor.principalKind,
      ...(actor.isAgentGrant === undefined ? {} : { isAgentGrant: actor.isAgentGrant }),
      pagePresent: inspected !== undefined,
      authorityCurrent: inspected?.authorityCurrent === true && actor.current(),
      pageHeldByAnother:
        existingForContext !== undefined ||
        (contextKey !== undefined && this.#claimingContexts.has(contextKey)),
      deviceHoldsAnotherPage:
        existingForDevice !== undefined || this.#claimingDevices.has(actor.deviceId),
      activeHostLeaseCount: this.#leases.size + this.#claimingDevices.size,
    });
    if (admission.status === "refused") return admission;
    if (inspected === undefined || contextKey === undefined) {
      return { status: "refused", reason: "page-not-here" };
    }

    const leaseId = decodePairedBrowserLeaseId(this.#options.uuid());
    const expiresAt = this.#nextExpiry();
    // Reserve the device, context, and host-cap slot synchronously before
    // awaiting host.claim so concurrent takeovers cannot bypass one-page-per-device
    // or one-controller-per-page limits.
    this.#claimingDevices.add(actor.deviceId);
    this.#claimingContexts.add(contextKey);
    let lease: ActivePairedLease;
    try {
      const claimed = await this.#options.host.claim({
        target: inspected.target,
        nativeTarget: inspected.nativeTarget,
        leaseId,
        deviceId: actor.deviceId,
        deviceName: actor.deviceName,
        expiresAt,
      });
      if (!claimed || this.#closed || signal?.aborted || !actor.current()) {
        if (claimed) {
          await this.#options.host
            .release(inspected.target, leaseId, "revoke")
            .catch(() => undefined);
        }
        return { status: "refused", reason: "page-not-here" };
      }

      lease = {
        id: leaseId,
        target: inspected.target,
        origin: inspected.origin,
        actor,
        abort: new AbortController(),
        eventSamples: [],
        charSamples: [],
        announcedChoosers: new Set<string>(),
        expiresAt,
        lastAcceptedSequence: 0,
        eventCount: 0,
        frameCount: 0,
        lastWithheldReason: undefined,
        stream: undefined,
        hostBusy: false,
        hostChain: Promise.resolve(),
        disconnectTimer: undefined,
        idleTimer: undefined,
        ended: false,
      };
      this.#leases.set(leaseId, lease);
      this.#byContext.set(contextKey, leaseId);
      this.#byDevice.set(actor.deviceId, leaseId);
    } finally {
      this.#claimingDevices.delete(actor.deviceId);
      this.#claimingContexts.delete(contextKey);
    }
    this.#armDisconnectTimer(lease);
    this.#armIdleTimer(lease);

    try {
      this.#options.journal({
        kind: "started",
        deviceId: actor.deviceId,
        threadId: inspected.target.threadId,
        contextId: inspected.target.contextId,
        tabId: inspected.target.tabId,
        profileKind: inspected.target.profileKind,
        origin: inspected.origin,
        leaseId,
      });
    } catch {
      await this.#endLease(lease, "revoked", { skipJournal: true });
      return { status: "refused", reason: "authority-ended" };
    }

    return {
      status: "held",
      leaseId,
      expiresAt,
      target: inspected.target,
    };
  }

  async handBackForThread(
    actor: PairedBrowserActor,
    threadId: BrowserThreadId,
    leaseId?: PairedBrowserLeaseId,
  ): Promise<PairedBrowserResponse> {
    const principal = decidePairedBrowserPrincipal(actor);
    if (principal.status === "refused") return principal;
    const resolvedId = leaseId ?? this.#byDevice.get(actor.deviceId);
    if (resolvedId === undefined) return { status: "refused", reason: "lease-ended" };
    const lease = this.#leases.get(resolvedId);
    if (lease === undefined || String(lease.target.threadId) !== String(threadId)) {
      return { status: "refused", reason: "lease-ended" };
    }
    return this.execute(actor, { kind: "hand-back", leaseId: lease.id });
  }

  async execute(
    actor: PairedBrowserActor,
    command: PairedBrowserRequest,
    signal?: AbortSignal,
  ): Promise<PairedBrowserResponse> {
    const principal = decidePairedBrowserPrincipal(actor);
    if (principal.status === "refused") return principal;
    if (this.#closed || signal?.aborted) return { status: "refused", reason: "lease-ended" };
    if (command.kind === "take-over") {
      return this.takeOver(actor, command.target.threadId, signal);
    }

    const lease = this.#leases.get(command.leaseId);
    if (lease === undefined || lease.ended) {
      return { status: "refused", reason: "lease-ended" };
    }
    if (!this.#matchesActor(lease, actor) || !actor.current() || !lease.actor.current()) {
      if (!lease.actor.current()) await this.#endLease(lease, "revoked");
      return { status: "refused", reason: "authority-ended" };
    }
    if (!this.#options.host.authorityCurrent(lease.target)) {
      await this.#endLease(lease, "page-ended");
      return { status: "refused", reason: "authority-ended" };
    }

    if (command.kind === "release") {
      await this.#endLease(lease, "disconnected");
      return { status: "released" };
    }

    if (command.kind === "hand-back") {
      const released = await this.#options.host.release(lease.target, lease.id, "hand-back");
      if (released.status !== "released") {
        if (released.reason === "reclaimed-locally") {
          await this.#endLease(lease, "reclaimed-locally", { skipHostRelease: true });
        }
        return { status: "refused", reason: "lease-ended" };
      }
      await this.#endLease(lease, "handed-back", { skipHostRelease: true });
      return { status: "released" };
    }

    if (command.kind !== "input") {
      return { status: "refused", reason: "authority-ended" };
    }

    // Input command: reserve sequence and rate budget synchronously before
    // awaiting native dispatch so concurrent retries with the same sequence
    // number can never pass admission twice, and never roll back a reserved
    // sequence after dispatch begins.
    const seq = evaluatePairedBrowserSequence({
      sequence: command.sequence,
      lastAcceptedSequence: lease.lastAcceptedSequence,
    });
    if (seq.status === "refused") {
      return { status: "refused", reason: "stale-frame", effect: "none" };
    }
    const now = this.#options.now();
    this.#pruneRateSamples(lease, now);
    const rate = evaluatePairedBrowserInputRate({
      events: command.events,
      window: {
        eventsInLastSecond: sumSamples(lease.eventSamples),
        charsInLastMinute: sumSamples(lease.charSamples),
      },
    });
    if (rate.status === "refused") {
      return { ...rate, effect: "none" };
    }
    for (const event of command.events) {
      if (event.kind === "key" && isForbiddenPairedBrowserKey(event)) {
        return { status: "refused", reason: "authority-ended", effect: "none" };
      }
    }

    lease.lastAcceptedSequence = command.sequence;
    lease.eventCount += command.events.length;
    lease.eventSamples.push({ at: now, count: command.events.length });
    const typedChars = countPairedBrowserTypedChars(command.events);
    if (typedChars > 0) lease.charSamples.push({ at: now, count: typedChars });
    this.#armIdleTimer(lease);

    const runDispatch = async (): Promise<PairedBrowserResponse> => {
      if (lease.ended || this.#closed || signal?.aborted) {
        return { status: "refused", reason: "lease-ended", effect: "none" };
      }
      if (!actor.current() || !lease.actor.current()) {
        await this.#endLease(lease, "revoked");
        return { status: "refused", reason: "authority-ended", effect: "none" };
      }
      if (!this.#options.host.authorityCurrent(lease.target)) {
        await this.#endLease(lease, "page-ended");
        return { status: "refused", reason: "authority-ended", effect: "none" };
      }
      const opSignal =
        signal === undefined ? lease.abort.signal : AbortSignal.any([signal, lease.abort.signal]);
      const result = await this.#options.host.input(
        lease.target,
        lease.id,
        command.events,
        opSignal,
      );
      if (result.status === "refused") {
        if (result.reason === "reclaimed-locally") {
          await this.#endLease(lease, "reclaimed-locally", { skipHostRelease: true });
          return { status: "refused", reason: "lease-ended", effect: "none" };
        }
        if (result.reason === "stale-frame" || result.reason === "outside-document") {
          return { status: "refused", reason: "stale-frame", effect: "none" };
        }
        return { status: "refused", reason: "lease-ended", effect: "none" };
      }
      if (result.status !== "input") {
        return { status: "refused", reason: "lease-ended", effect: "none" };
      }
      this.#armIdleTimer(lease);
      return {
        status: "input",
        lastAcceptedSequence: command.sequence,
        effect: result.effect,
      };
    };

    return this.#enqueueHostOp(lease, runDispatch);
  }

  openStream(
    actor: PairedBrowserActor,
    leaseId: PairedBrowserLeaseId,
    signal?: AbortSignal,
  ): PairedBrowserStreamOpenResult {
    const principal = decidePairedBrowserPrincipal(actor);
    if (principal.status === "refused") return principal;
    if (this.#closed || signal?.aborted) return { status: "refused", reason: "lease-ended" };
    const lease = this.#leases.get(leaseId);
    if (lease === undefined || lease.ended) return { status: "refused", reason: "lease-ended" };
    if (!this.#matchesActor(lease, actor) || !actor.current() || !lease.actor.current()) {
      if (!lease.actor.current()) void this.#endLease(lease, "revoked");
      return { status: "refused", reason: "authority-ended" };
    }
    if (!this.#options.host.authorityCurrent(lease.target)) {
      void this.#endLease(lease, "page-ended");
      return { status: "refused", reason: "authority-ended" };
    }
    if (lease.stream !== undefined) {
      return { status: "refused", reason: "rate-limited", retryAfterSeconds: 1 };
    }

    this.#clearDisconnectTimer(lease);
    let closed = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

    const cleanup = (disconnectedByClient: boolean) => {
      if (closed) return;
      closed = true;
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      if (lease.stream === sink) lease.stream = undefined;
      if (disconnectedByClient && !lease.ended && !this.#closed) {
        this.#armDisconnectTimer(lease);
      }
    };

    const sink: StreamSink = {
      push: (event) => {
        if (closed || controllerRef === undefined) return;
        try {
          const line = `${JSON.stringify(decodePairedBrowserStreamEvent(event))}\n`;
          controllerRef.enqueue(encoder.encode(line));
        } catch {
          cleanup(true);
        }
      },
      close: () => {
        if (closed) return;
        const ref = controllerRef;
        cleanup(false);
        try {
          ref?.close();
        } catch {
          /* Stream already closed. */
        }
      },
    };
    lease.stream = sink;

    const scheduleNext = () => {
      if (closed || lease.ended || this.#closed) return;
      pollTimer = setTimeout(() => {
        pollTimer = undefined;
        void tick();
      }, this.#frameIntervalMs);
      pollTimer.unref?.();
    };

    const tick = async () => {
      if (closed || lease.ended || this.#closed || inFlight) return;
      if (!lease.actor.current()) {
        await this.#endLease(lease, "revoked");
        return;
      }
      if (!this.#options.host.authorityCurrent(lease.target)) {
        await this.#endLease(lease, "page-ended");
        return;
      }
      // Backpressure: if the client has not read the previous frame yet, skip
      // capturing a new one instead of queueing frames in memory.
      if (controllerRef !== undefined && (controllerRef.desiredSize ?? 1) <= 0) {
        scheduleNext();
        return;
      }
      inFlight = true;
      try {
        await this.#enqueueHostOp(lease, async () => {
          if (closed || lease.ended || this.#closed) return;
          if (!lease.actor.current()) {
            await this.#endLease(lease, "revoked");
            return;
          }
          if (!this.#options.host.authorityCurrent(lease.target)) {
            await this.#endLease(lease, "page-ended");
            return;
          }
          const opSignal =
            signal === undefined
              ? lease.abort.signal
              : AbortSignal.any([signal, lease.abort.signal]);
          const result = await this.#options.host.frame(lease.target, lease.id, opSignal);
          if (closed || lease.ended) return;
          if (!lease.actor.current()) {
            await this.#endLease(lease, "revoked");
            return;
          }
          if (result.status === "frame") {
            lease.lastWithheldReason = undefined;
            lease.frameCount += 1;
            this.#armIdleTimer(lease);
            sink.push({ kind: "frame", ...result.frame });
            if (
              result.fileChooser !== undefined &&
              !lease.announcedChoosers.has(String(result.fileChooser.chooserId))
            ) {
              lease.announcedChoosers.add(String(result.fileChooser.chooserId));
              sink.push({ kind: "file-chooser", ...result.fileChooser });
            }
          } else if (result.status === "withheld") {
            if (lease.lastWithheldReason !== result.reason) {
              lease.lastWithheldReason = result.reason;
              sink.push({ kind: "withheld", reason: result.reason });
            }
            if (
              result.fileChooser !== undefined &&
              !lease.announcedChoosers.has(String(result.fileChooser.chooserId))
            ) {
              lease.announcedChoosers.add(String(result.fileChooser.chooserId));
              sink.push({ kind: "file-chooser", ...result.fileChooser });
            }
          } else if (result.status === "refused" && result.reason === "reclaimed-locally") {
            await this.#endLease(lease, "reclaimed-locally", { skipHostRelease: true });
          }
        });
      } catch {
        /* Transient capture error retries on next tick while lease stays live. */
      } finally {
        inFlight = false;
      }
      scheduleNext();
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controllerRef = controller;
        signal?.addEventListener(
          "abort",
          () => {
            cleanup(true);
            try {
              controller.close();
            } catch {
              /* Already closed. */
            }
          },
          { once: true },
        );
        void tick();
      },
      cancel: () => {
        cleanup(true);
      },
    });
    return { status: "stream", stream };
  }

  async uploadFile(
    actor: PairedBrowserActor,
    input: {
      readonly leaseId: PairedBrowserLeaseId;
      readonly chooserId: PairedBrowserChooserId;
      readonly fileName: string;
      readonly bytes: Uint8Array;
      readonly signal?: AbortSignal;
    },
  ): Promise<PairedBrowserResponse> {
    const principal = decidePairedBrowserPrincipal(actor);
    if (principal.status === "refused") return principal;
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_PAIRED_BROWSER_FILE_BYTES) {
      return { status: "refused", reason: "rate-limited" };
    }
    const lease = this.#leases.get(input.leaseId);
    if (lease === undefined || lease.ended) return { status: "refused", reason: "lease-ended" };
    if (!this.#matchesActor(lease, actor) || !actor.current() || !lease.actor.current()) {
      if (!lease.actor.current()) await this.#endLease(lease, "revoked");
      return { status: "refused", reason: "authority-ended" };
    }
    if (!this.#options.host.authorityCurrent(lease.target)) {
      await this.#endLease(lease, "page-ended");
      return { status: "refused", reason: "authority-ended" };
    }

    const safeName = sanitizeUploadFileName(input.fileName);
    const stagingDir = await mkdtemp(join(tmpdir(), "octant-paired-upload-"));
    const stagedPath = join(stagingDir, safeName);
    const cleanup = () => rm(stagingDir, { recursive: true, force: true });
    let retained = false;
    try {
      await writeFile(stagedPath, input.bytes, { mode: 0o600 });
      const opSignal =
        input.signal === undefined
          ? lease.abort.signal
          : AbortSignal.any([input.signal, lease.abort.signal]);
      const result = await this.#enqueueHostOp(
        lease,
        async (): Promise<PairedBrowserNativeResult> => {
          if (lease.ended || this.#closed || input.signal?.aborted) {
            return { status: "refused", reason: "unavailable" };
          }
          return this.#options.host.fileChoice(
            lease.target,
            lease.id,
            input.chooserId,
            [stagedPath],
            opSignal,
          );
        },
      );
      if (result.status !== "file-chosen") {
        return { status: "refused", reason: "lease-ended" };
      }
      // Retain the staged copy for the browser context's lifetime so the page's
      // form can still read and submit the attached file after chooser selection.
      if (!this.#closed && this.#options.host.authorityCurrent(lease.target)) {
        this.#keepStagedUpload(String(lease.target.contextId), cleanup);
        retained = true;
      }
      this.#armIdleTimer(lease);
      return { status: "released" };
    } finally {
      if (!retained) {
        await cleanup().catch(() => undefined);
      }
    }
  }

  async reclaimLocally(contextId: BrowserContextId): Promise<void> {
    const id = this.#byContext.get(String(contextId));
    const lease = id === undefined ? undefined : this.#leases.get(id);
    if (lease !== undefined) {
      await this.#endLease(lease, "reclaimed-locally");
    }
  }

  async pageEnded(contextId: BrowserContextId): Promise<void> {
    const id = this.#byContext.get(String(contextId));
    const lease = id === undefined ? undefined : this.#leases.get(id);
    if (lease !== undefined) {
      await this.#endLease(lease, "page-ended");
    }
    await this.#releaseStagedUploads(String(contextId));
  }

  async signInSettled(contextId: BrowserContextId): Promise<void> {
    const id = this.#byContext.get(String(contextId));
    const lease = id === undefined ? undefined : this.#leases.get(id);
    if (lease !== undefined) {
      await this.#endLease(lease, "agent-sign-in");
    }
  }

  revalidateAuthority(): void {
    if (this.#closed) return;
    for (const lease of [...this.#leases.values()]) {
      let actorOk = false;
      let pageOk = false;
      try {
        actorOk = lease.actor.current();
        pageOk = this.#options.host.authorityCurrent(lease.target);
      } catch {
        /* Missing authoritative state ends the lease closed. */
      }
      if (!actorOk) {
        void this.#endLease(lease, "revoked");
      } else if (!pageOk) {
        void this.#endLease(lease, "page-ended");
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes.length = 0;
    await Promise.allSettled(
      [...this.#leases.values()].map((lease) => this.#endLease(lease, "page-ended")),
    );
    await Promise.allSettled(
      [...this.#stagedUploads.keys()].map((contextId) => this.#releaseStagedUploads(contextId)),
    );
  }

  #enqueueHostOp<T>(lease: ActivePairedLease, run: () => Promise<T>): Promise<T> {
    let pending: Promise<T>;
    if (!lease.hostBusy) {
      lease.hostBusy = true;
      try {
        pending = run();
      } catch (error) {
        lease.hostBusy = false;
        throw error;
      }
    } else {
      pending = lease.hostChain.then(run, run);
    }
    const done = pending.then(
      () => undefined,
      () => undefined,
    );
    lease.hostChain = done;
    void done.finally(() => {
      if (lease.hostChain === done) {
        lease.hostBusy = false;
      }
    });
    return pending;
  }

  #keepStagedUpload(contextId: string, cleanup: () => Promise<void>): void {
    const kept = this.#stagedUploads.get(contextId) ?? [];
    kept.push(cleanup);
    while (kept.length > MAX_PAIRED_STAGED_UPLOADS) {
      void kept
        .shift()?.()
        .catch(() => undefined);
    }
    this.#stagedUploads.set(contextId, kept);
  }

  async #releaseStagedUploads(contextId: string): Promise<void> {
    const kept = this.#stagedUploads.get(contextId);
    if (kept === undefined) return;
    this.#stagedUploads.delete(contextId);
    await Promise.allSettled(kept.map((cleanup) => cleanup()));
  }

  #matchesActor(lease: ActivePairedLease, actor: PairedBrowserActor): boolean {
    return (
      lease.actor.deviceId === actor.deviceId &&
      lease.actor.sessionId === actor.sessionId &&
      lease.actor.credentialGeneration === actor.credentialGeneration
    );
  }

  #leaseValid(lease: ActivePairedLease): boolean {
    return (
      !lease.ended && lease.actor.current() && this.#options.host.authorityCurrent(lease.target)
    );
  }

  #nextExpiry(): UtcTimestamp {
    return Schema.decodeUnknownSync(UtcTimestamp)(
      new Date(Date.parse(this.#options.timestamp()) + this.#idleTimeoutMs).toISOString(),
    );
  }

  #armDisconnectTimer(lease: ActivePairedLease): void {
    this.#clearDisconnectTimer(lease);
    lease.disconnectTimer = setTimeout(() => {
      lease.disconnectTimer = undefined;
      void this.#endLease(lease, "disconnected");
    }, this.#disconnectTimeoutMs);
    lease.disconnectTimer.unref?.();
  }

  #clearDisconnectTimer(lease: ActivePairedLease): void {
    if (lease.disconnectTimer !== undefined) {
      clearTimeout(lease.disconnectTimer);
      lease.disconnectTimer = undefined;
    }
  }

  #armIdleTimer(lease: ActivePairedLease): void {
    if (lease.idleTimer !== undefined) clearTimeout(lease.idleTimer);
    lease.expiresAt = this.#nextExpiry();
    lease.idleTimer = setTimeout(() => {
      lease.idleTimer = undefined;
      void this.#endLease(lease, "disconnected");
    }, this.#idleTimeoutMs);
    lease.idleTimer.unref?.();
  }

  #pruneRateSamples(lease: ActivePairedLease, now: number): void {
    while (lease.eventSamples[0] !== undefined && now - lease.eventSamples[0].at >= 1_000) {
      lease.eventSamples.shift();
    }
    while (lease.charSamples[0] !== undefined && now - lease.charSamples[0].at >= 60_000) {
      lease.charSamples.shift();
    }
  }

  async #endLease(
    lease: ActivePairedLease,
    reason: PairedBrowserEndReason,
    options?: { readonly skipHostRelease?: boolean; readonly skipJournal?: boolean },
  ): Promise<void> {
    if (lease.ended) return;
    lease.ended = true;
    lease.abort.abort();
    this.#clearDisconnectTimer(lease);
    if (lease.idleTimer !== undefined) {
      clearTimeout(lease.idleTimer);
      lease.idleTimer = undefined;
    }
    if (this.#leases.get(lease.id) === lease) this.#leases.delete(lease.id);
    if (this.#byContext.get(String(lease.target.contextId)) === lease.id) {
      this.#byContext.delete(String(lease.target.contextId));
    }
    if (this.#byDevice.get(lease.actor.deviceId) === lease.id) {
      this.#byDevice.delete(lease.actor.deviceId);
    }

    if (lease.stream !== undefined) {
      if (reason === "reclaimed-locally") {
        lease.stream.push({ kind: "reclaimed-locally" });
      }
      lease.stream.push({ kind: "ended", reason });
      lease.stream.close();
    }

    if (options?.skipHostRelease !== true) {
      await this.#options.host.release(lease.target, lease.id, "revoke").catch(() => undefined);
    }

    if (options?.skipJournal !== true) {
      try {
        this.#options.journal({
          kind: "ended",
          deviceId: lease.actor.deviceId,
          threadId: lease.target.threadId,
          contextId: lease.target.contextId,
          tabId: lease.target.tabId,
          profileKind: lease.target.profileKind,
          origin: lease.origin,
          leaseId: lease.id,
          endReason: reason,
          eventCount: lease.eventCount,
          frameCount: lease.frameCount,
        });
      } catch {
        /* Lease is already ended even if journaling fails during shutdown. */
      }
    }
  }
}

function sumSamples(samples: ReadonlyArray<RateSample>): number {
  let total = 0;
  for (const sample of samples) total += sample.count;
  return total;
}

function sanitizeUploadFileName(raw: string): string {
  const leaf = basename(raw.replaceAll("\\", "/")).replace(/[^\w.-]/g, "_");
  return leaf.length > 0 && leaf !== "." && leaf !== ".." ? leaf.slice(0, 128) : "upload.bin";
}
