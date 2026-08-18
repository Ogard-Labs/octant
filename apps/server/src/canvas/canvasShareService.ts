import {
  CANVAS_SHARE_MAX_ACCESS_LOG_EVENTS,
  CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS,
  decodeCanvasId,
  decodeCanvasShareAccessRequest,
  decodeCanvasShareAccessResult,
  decodeCanvasShareOverview,
  decodeCanvasShareResult,
  decodeCanvasShareSnapshotRequest,
  decodeCanvasShareSnapshotRevokeRequest,
  decodeCanvasShareSnapshotSummary,
  type CanvasId,
  type CanvasShareAccessLogEvent,
  type CanvasShareAccessRequest,
  type CanvasShareAccessResult,
  type CanvasShareDenialCode,
  type CanvasShareOverview,
  type CanvasShareResult,
  type CanvasShareSnapshotRecord,
  type CanvasShareSnapshotStatus,
  type CanvasShareSnapshotSummary,
  type UtcTimestamp,
} from "@octant/contracts";
import {
  CanvasSharePolicyRejected,
  CanvasShareAccessLogPolicyRejected,
  CanvasShareSnapshotPolicyRejected,
  buildCanvasShareAccessLogEvent,
  createCanvasShareSnapshotRecord,
  revokeCanvasShareSnapshot,
  validateCanvasShareAccessLogEvent,
} from "@octant/domain";
import type { ClientPrincipal } from "../clientPrincipal";
import type { CanvasProjection } from "./canvasProjection";
import { CanvasShareEventStore, CanvasShareEventStoreError } from "./canvasShareEventStore";
import type { CanvasAuthorizationContext, CanvasProjectRecord } from "./canvasService";

/**
 * Who this host authenticated for one share operation, in the terms the
 * snapshot audience is written in.
 *
 * This is derived from the request's transport principal and never from the
 * request itself: a local window is the host user this share belongs to, and a
 * request the remote gateway authenticated is the paired device it named. The
 * two are not interchangeable, so an audience that admits one refuses the other.
 */
export type CanvasShareReader =
  | { readonly kind: "local-user"; readonly principalId: string }
  | { readonly kind: "paired-device"; readonly principalId: string };

export interface CanvasShareServiceOptions {
  readonly projection: CanvasProjection;
  readonly eventStore: CanvasShareEventStore;
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
  /** This host's authoritative identity; a share may never claim another host. */
  readonly hostId: string;
  /** The authenticated local user this host shares as. */
  readonly owner: { readonly kind: "local-user"; readonly actorId: string };
  /**
   * Whether this host shares at all. A host with sharing off keeps full local
   * Canvas use and fails every share, revoke, and snapshot read closed.
   */
  readonly sharingEnabled?: boolean;
}

export interface CanvasShareServiceDependencies {
  /** The same server-owned Canvas authority used for every other Canvas mutation. */
  readonly authorize: (
    entry: NonNullable<ReturnType<CanvasProjection["getById"]>>,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ) => boolean;
}

/**
 * Server-authoritative Canvas sharing.
 *
 * Sharing is the one Canvas operation whose product leaves a thread's scope, so
 * this service owns the whole boundary:
 *
 * - Creating or revoking a share requires the same Canvas authority as any other
 *   Canvas mutation, plus the snapshot policy's own consent, scope, and expiry
 *   checks against the authoritative current version.
 * - Reading a shared snapshot is authorized by the snapshot alone — audience
 *   membership, expiry, and revocation evaluated at request time against the
 *   host-authenticated principal, never a client claim. What it serves is the
 *   sanitized snapshot document already admitted at create time, so a share can
 *   never reach past the snapshot into live Canvas or host state.
 * - Every evaluated read is journaled as a privacy-preserving access-log event
 *   before its outcome is returned, so an allowed read, a revoked read, and a
 *   request that named the wrong Canvas are equally auditable.
 *
 * Nothing here leaves the host: a snapshot is served only over the loopback
 * Canvas API to a principal this host can authenticate. There is no link, no
 * upload, and no relay.
 */
export class CanvasShareService {
  readonly #projection: CanvasProjection;
  readonly #eventStore: CanvasShareEventStore;
  readonly #uuid: () => string;
  readonly #clock: () => UtcTimestamp;
  readonly #hostId: string;
  readonly #owner: { readonly kind: "local-user"; readonly actorId: string };
  readonly #sharingEnabled: boolean;
  readonly #authorize: CanvasShareServiceDependencies["authorize"];
  readonly #records = new Map<string, CanvasShareSnapshotRecord>();
  /**
   * The access log an overview can publish, held per Canvas and capped at the
   * published window. The journal keeps every evaluated read; this projection
   * keeps only what an owner can be shown, so one heavily read Canvas can
   * neither evict another Canvas's log nor grow this rebuild without bound.
   */
  readonly #accessEvents = new Map<string, CanvasShareAccessLogEvent[]>();

  constructor(options: CanvasShareServiceOptions, dependencies: CanvasShareServiceDependencies) {
    this.#projection = options.projection;
    this.#eventStore = options.eventStore;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#hostId = options.hostId;
    this.#owner = options.owner;
    this.#sharingEnabled = options.sharingEnabled ?? true;
    this.#authorize = dependencies.authorize;
    // Share state is a projection of the journal, so it is rebuilt by replay on
    // every start rather than carried across restarts in memory.
    const replayed = options.eventStore.replay();
    for (const record of replayed.records) this.#records.set(String(record.snapshotId), record);
    for (const event of replayed.accessEvents) this.#recordAccessEvent(event);
  }

  /**
   * What the owner may see and echo for one Canvas: this host's share posture,
   * the local-user owner a share's consent must name, and the current share rows
   * with their access log. Returns `undefined` when the caller has no authority
   * over the Canvas at all.
   */
  overview(
    canvasId: CanvasId,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
  ): CanvasShareOverview | undefined {
    const entry = this.#projection.getById(canvasId);
    if (entry === undefined) return undefined;
    if (!this.#authorize(entry, context, project)) return undefined;
    const provenance = entry.currentVersion.definition.provenance;
    const nowIso = this.#clock();
    const snapshots = boundedOverviewSnapshots(
      [...this.#records.values()]
        .filter((record) => String(record.canvasId) === String(canvasId))
        .map((record) => this.#summarize(record, nowIso)),
    );
    const accessLog = (this.#accessEvents.get(String(canvasId)) ?? []).slice();
    return decodeCanvasShareOverview({
      schemaVersion: 1,
      kind: "canvas-share-overview",
      canvasId,
      hostId: this.#hostId,
      projectId: provenance.projectId,
      sharingEnabled: this.#sharingEnabled,
      owner: this.#owner,
      snapshots,
      accessLog,
    });
  }

  /**
   * Admit an owner-consented authenticated snapshot of the current version.
   *
   * `principal` is required so the compiler rejects any call site that would
   * let this host's owner identity stand in for whoever actually asked.
   */
  share(
    requestInput: unknown,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
    principal: ClientPrincipal,
  ): CanvasShareResult {
    // Minting a share is an owner action: it records the owner's consent and
    // names the owner as the actor. A paired device may read a share it is in
    // the audience of, but it may never issue one in the owner's name.
    if (this.#reader(principal).kind !== "local-user") {
      return denied("unauthorized", "Canvas sharing requires the host user.");
    }
    let canvasId: CanvasId;
    let snapshotId: string;
    try {
      const decoded = decodeCanvasShareSnapshotRequest(requestInput);
      canvasId = decodeCanvasId(decoded.canvasId);
      snapshotId = String(decoded.snapshotId);
    } catch {
      return denied("malformed-request", "Canvas share request is malformed.");
    }
    const entry = this.#projection.getById(canvasId);
    if (entry === undefined) {
      return denied("unavailable", "Canvas is unavailable. Reopen it from the Project.");
    }
    if (!this.#authorize(entry, context, project) || project === undefined) {
      return denied("unauthorized", "Canvas sharing is not authorized in this workspace.");
    }
    // A repeated snapshot id replays its admitted share rather than minting a
    // second one; a reused id pointed at a different Canvas fails closed.
    const existing = this.#records.get(snapshotId);
    if (existing !== undefined) {
      if (String(existing.canvasId) !== String(canvasId)) {
        return denied("unauthorized", "Share identity does not match the recorded snapshot.");
      }
      return accepted(this.#summarize(existing, this.#clock()));
    }
    // The overview is the only surface a live share can be revoked from, and it
    // carries a bounded number of rows, so a Canvas may hold no more live shares
    // than an overview can publish. Refusing to mint here is what keeps that
    // authority reachable: the owner is asked to withdraw one share rather than
    // handed one they could never withdraw. A host with sharing off is left to
    // answer with its own posture, because revoking would not help there.
    if (
      this.#sharingEnabled &&
      this.#liveShareCount(canvasId, this.#clock()) >= CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS
    ) {
      return denied(
        "unavailable",
        `Canvas sharing is at its limit of ${CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS} live shares. Revoke one to share again.`,
      );
    }
    try {
      const record = createCanvasShareSnapshotRecord({
        request: requestInput,
        current: entry.currentVersion,
        context: {
          sharingEnabled: this.#sharingEnabled,
          hostId: this.#hostId,
          projectId: String(project.id),
          nowIso: this.#clock(),
          actor: { kind: "local-user", actorId: this.#owner.actorId },
        },
      });
      this.#eventStore.appendSnapshotCreated({ record, occurredAt: record.createdAt });
      this.#records.set(String(record.snapshotId), record);
      return accepted(this.#summarize(record, this.#clock()));
    } catch (error) {
      return this.#deniedFromError(error, "Canvas share could not be created.");
    }
  }

  /** Withdraw an owner's share. A revoked snapshot is never served again. */
  revoke(
    requestInput: unknown,
    context: CanvasAuthorizationContext,
    project: CanvasProjectRecord | undefined,
    principal: ClientPrincipal,
  ): CanvasShareResult {
    // Withdrawal is recorded as the owner's act, so it is the owner's to make.
    if (this.#reader(principal).kind !== "local-user") {
      return denied("unauthorized", "Canvas share revoke requires the host user.");
    }
    let snapshotId: string;
    try {
      snapshotId = String(decodeCanvasShareSnapshotRevokeRequest(requestInput).snapshotId);
    } catch {
      return denied("malformed-request", "Canvas share revoke request is malformed.");
    }
    // Revocation is never gated on this host's share posture: withdrawing a
    // share only narrows access, and turning sharing off must not trap an
    // existing share in a state its owner cannot permanently withdraw.
    const record = this.#records.get(snapshotId);
    if (record === undefined) {
      return denied("unavailable", "This share is unavailable.");
    }
    const entry = this.#projection.getById(decodeCanvasId(record.canvasId));
    if (entry === undefined || !this.#authorize(entry, context, project)) {
      return denied("unauthorized", "Canvas share revoke is not authorized in this workspace.");
    }
    try {
      const revoked = revokeCanvasShareSnapshot({
        record,
        request: requestInput,
        nowIso: this.#clock(),
        actor: { kind: "local-user", actorId: this.#owner.actorId },
      });
      const revokedAt = revoked.status === "revoked" ? revoked.revokedAt : this.#clock();
      this.#eventStore.appendSnapshotRevoked({
        revocation: {
          snapshotId: revoked.snapshotId,
          canvasId: revoked.canvasId,
          hostId: revoked.hostId,
          projectId: revoked.projectId,
          revokedAt,
          actor: { kind: "local-user", actorId: this.#owner.actorId },
        },
        occurredAt: revokedAt,
      });
      this.#records.set(String(revoked.snapshotId), revoked);
      return accepted(this.#summarize(revoked, this.#clock()));
    } catch (error) {
      return this.#deniedFromError(error, "Canvas share could not be revoked.");
    }
  }

  /**
   * Serve a shared snapshot to the host-authenticated principal, or refuse it.
   * Either way the evaluated outcome is journaled first: an access that cannot
   * be recorded is refused rather than served unaudited.
   */
  access(input: {
    readonly request: unknown;
    /**
     * The transport principal this host authenticated. Required rather than
     * defaulted: a default here would evaluate and journal a paired device's
     * read as the host user, which is exactly the audience the snapshot may
     * have been minted for.
     */
    readonly principal: ClientPrincipal;
    /** Reduced to a coarse browser family by policy; never stored raw. */
    readonly userAgent?: string;
  }): CanvasShareAccessResult {
    const reader = this.#reader(input.principal);
    let request: CanvasShareAccessRequest;
    try {
      request = decodeCanvasShareAccessRequest(input.request);
    } catch {
      return unavailable("malformed-request", "Canvas share access request is malformed.");
    }
    if (!this.#sharingEnabled) {
      // A host that stops sharing still holds the snapshots it minted, and a
      // read replayed against one of them is an evaluated read the owner must
      // be able to see. Journal it against the snapshot's own scope first, then
      // refuse.
      //
      // An unknown snapshot id is journaled for nobody: there is no record to
      // evaluate, and writing a row for a guessed id would make the owner's own
      // log an oracle a guesser could drive. The caller cannot tell the two
      // apart — both receive exactly this refusal — so only the owner's view
      // differs, which is precisely who the journal is for.
      const known = this.#records.get(String(request.snapshotId));
      if (known !== undefined) {
        this.#journalEvaluation({
          record: known,
          reader,
          nowIso: this.#clock(),
          sourceDeleted: false,
          scopeMismatch: false,
          sharingDisabled: true,
          ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
        });
      }
      return unavailable("sharing-disabled", "Canvas sharing is disabled on this host.");
    }
    const record = this.#records.get(String(request.snapshotId));
    if (record === undefined) {
      return unavailable("unavailable", "This share is unavailable.");
    }
    const scopeMismatch =
      String(record.canvasId) !== String(request.canvasId) ||
      record.hostId !== request.hostId ||
      String(record.projectId) !== String(request.projectId) ||
      request.hostId !== this.#hostId;
    const nowIso = this.#clock();
    // A Canvas that no longer exists is an honest deleted-source denial, not a
    // silently allowed read of a snapshot whose origin is gone. A scope probe
    // never reaches that far: it is refused on the snapshot it named.
    const sourceDeleted =
      !scopeMismatch && this.#projection.getById(decodeCanvasId(record.canvasId)) === undefined;
    const journaled = this.#journalEvaluation({
      record,
      reader,
      nowIso,
      sourceDeleted,
      scopeMismatch,
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
    });
    if (journaled.status === "unrecordable") {
      return unavailable(
        "unavailable",
        "Canvas share access could not be recorded, so it was refused.",
      );
    }
    // The probe is now auditable, but its refusal still says nothing about the
    // snapshot it guessed at: a caller who names the wrong Canvas learns only
    // that this request did not match, never the scope, audience, or lifecycle
    // of a share it was never given.
    if (scopeMismatch) {
      return unavailable("scope-mismatch", "This share does not match the requested scope.");
    }
    const event = journaled.event;
    if (event.outcome !== "allowed") {
      return decodeCanvasShareAccessResult({ kind: "denied", outcome: event.outcome, event });
    }
    return decodeCanvasShareAccessResult({
      kind: "allowed",
      document: record.document,
      event,
    });
  }

  /**
   * Journal one evaluated read before its outcome is returned. The event
   * carries the snapshot's own scope and the authenticated principal — never
   * the scope a caller supplied, and never the document. An evaluation that
   * cannot be recorded is reported as unrecordable so the read is refused
   * rather than served or denied unaudited.
   */
  #journalEvaluation(input: {
    readonly record: CanvasShareSnapshotRecord;
    /** The authenticated reader this evaluation is both decided and recorded for. */
    readonly reader: CanvasShareReader;
    readonly nowIso: UtcTimestamp;
    readonly sourceDeleted: boolean;
    readonly scopeMismatch: boolean;
    /** This host refuses to share at all; it outranks every other reason. */
    readonly sharingDisabled?: boolean;
    readonly userAgent?: string;
  }):
    | { readonly status: "journaled"; readonly event: CanvasShareAccessLogEvent }
    | {
        readonly status: "unrecordable";
      } {
    let event: CanvasShareAccessLogEvent;
    try {
      event = buildCanvasShareAccessLogEvent({
        eventId: this.#uuid(),
        record: input.record,
        nowIso: input.nowIso,
        principalId: input.reader.principalId,
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
        sourceDeleted: input.sourceDeleted,
        scopeMismatch: input.scopeMismatch,
        sharingDisabled: input.sharingDisabled ?? false,
      });
      validateCanvasShareAccessLogEvent({
        event,
        record: input.record,
        authenticatedPrincipalId: input.reader.principalId,
        sourceDeleted: input.sourceDeleted,
        scopeMismatch: input.scopeMismatch,
        sharingDisabled: input.sharingDisabled ?? false,
      });
      this.#eventStore.appendAccessLogged({ event, occurredAt: event.occurredAt });
    } catch (error) {
      if (
        error instanceof CanvasShareAccessLogPolicyRejected ||
        error instanceof CanvasShareEventStoreError
      ) {
        return { status: "unrecordable" };
      }
      throw error;
    }
    this.#recordAccessEvent(event);
    return { status: "journaled", event };
  }

  /**
   * Keep one journaled access event in its Canvas's published window, dropping
   * that Canvas's oldest event once the window is full. Applying the same
   * journal again therefore yields the same log, whether it arrives one live
   * read at a time or as a whole replayed history.
   */
  #recordAccessEvent(event: CanvasShareAccessLogEvent): void {
    const canvasKey = String(event.canvasId);
    const events = this.#accessEvents.get(canvasKey);
    if (events === undefined) {
      this.#accessEvents.set(canvasKey, [event]);
      return;
    }
    events.push(event);
    if (events.length > CANVAS_SHARE_MAX_ACCESS_LOG_EVENTS) events.shift();
  }

  /**
   * Resolve the authenticated transport principal into the audience's own
   * terms. A local window is this host's user, so it reads as the owner actor a
   * share's audience names; a gateway-authenticated request is the paired
   * device it authenticated, and stays that device. Nothing here consults the
   * request, so a caller cannot name itself.
   */
  #reader(principal: ClientPrincipal): CanvasShareReader {
    if (principal.kind === "remote-device") {
      return { kind: "paired-device", principalId: String(principal.deviceId) };
    }
    return { kind: "local-user", principalId: this.#owner.actorId };
  }

  /**
   * Which Canvases carry a live share right now.
   *
   * Derived from the same lifecycle the overview publishes, so the library's
   * Shared tab and a Canvas's own share panel can never disagree about whether
   * something is shared. Expiry is time-derived, so this is recomputed on every
   * ask rather than kept as a set that would quietly go stale.
   */
  liveShareCanvasIds(): ReadonlySet<string> {
    const nowIso = this.#clock();
    const live = new Set<string>();
    for (const record of this.#records.values()) {
      if (isLiveShareStatus(effectiveShareStatus(record, nowIso))) {
        live.add(String(record.canvasId));
      }
    }
    return live;
  }

  /**
   * How many of this Canvas's shares still carry authority at `nowIso`, counted
   * through the same lifecycle the overview publishes. Expiry frees capacity as
   * time passes, so this is derived from the clock on every ask rather than kept
   * as a stored count that could drift from what the owner sees.
   */
  #liveShareCount(canvasId: CanvasId, nowIso: UtcTimestamp): number {
    let live = 0;
    for (const record of this.#records.values()) {
      if (String(record.canvasId) !== String(canvasId)) continue;
      if (isLiveShareStatus(effectiveShareStatus(record, nowIso))) live += 1;
    }
    return live;
  }

  /**
   * Owner-visible row for one share. Expiry is time-derived rather than an
   * event, so a snapshot past `expiresAt` reads as expired without rewriting the
   * journal — exactly what the access evaluation enforces.
   */
  #summarize(record: CanvasShareSnapshotRecord, nowIso: UtcTimestamp): CanvasShareSnapshotSummary {
    const status = effectiveShareStatus(record, nowIso);
    return decodeCanvasShareSnapshotSummary({
      schemaVersion: 1,
      kind: "canvas-share-snapshot-summary",
      snapshotId: record.snapshotId,
      canvasId: record.canvasId,
      versionId: record.versionId,
      sequence: record.sequence,
      hostId: record.hostId,
      projectId: record.projectId,
      audience: record.audience,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      refreshPolicy: record.refreshPolicy,
      status,
      ...(record.status === "revoked" ? { revokedAt: record.revokedAt } : {}),
    });
  }

  #deniedFromError(error: unknown, fallback: string): CanvasShareResult {
    if (
      error instanceof CanvasShareSnapshotPolicyRejected ||
      error instanceof CanvasSharePolicyRejected
    ) {
      return denied(error.denialCode, error.message);
    }
    if (error instanceof CanvasShareEventStoreError) {
      return denied("unavailable", fallback);
    }
    throw error;
  }
}

/**
 * The lifecycle one share reads as at `nowIso`. Expiry is time-derived rather
 * than an event, so this is the single place a snapshot becomes expired, for the
 * owner's row and for every rule that counts live shares alike.
 */
function effectiveShareStatus(
  record: CanvasShareSnapshotRecord,
  nowIso: UtcTimestamp,
): CanvasShareSnapshotStatus {
  if (record.status === "revoked") return "revoked";
  return Date.parse(String(record.expiresAt)) <= Date.parse(String(nowIso))
    ? "expired"
    : record.status;
}

/**
 * Whether a share still carries authority: its audience can still read it, so
 * the owner must still be able to withdraw it.
 */
function isLiveShareStatus(status: CanvasShareSnapshotStatus): boolean {
  return status !== "revoked" && status !== "expired";
}

/**
 * The share rows an overview may carry, when a Canvas holds more than that.
 *
 * An owner keeps every snapshot they ever minted, so this is reachable on a
 * long-lived Canvas, and the alternative is not a longer list: the overview
 * schema bounds the field, so an unbounded array fails to decode and the owner
 * then sees no shares at all and can revoke none of them.
 *
 * Only settled rows are ever dropped. A revoked or expired snapshot carries no
 * authority, so hiding it loses the owner nothing they can act on. A live one is
 * authority this overview is the only way to reach, and `share()` refuses to
 * mint a live share this list could not carry, so live rows never exceed the
 * bound and are never dropped here. The most recent settled rows are kept,
 * because `#records` holds them in the order they were minted.
 */
function boundedOverviewSnapshots(
  summaries: ReadonlyArray<CanvasShareSnapshotSummary>,
): ReadonlyArray<CanvasShareSnapshotSummary> {
  if (summaries.length <= CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS) return summaries;
  const live = summaries.filter((summary) => isLiveShareStatus(summary.status));
  if (live.length >= CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS) {
    return live.slice(live.length - CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS);
  }
  const settled = summaries.filter((summary) => !isLiveShareStatus(summary.status));
  const room = CANVAS_SHARE_MAX_OVERVIEW_SNAPSHOTS - live.length;
  return [...settled.slice(settled.length - room), ...live];
}

function accepted(snapshot: CanvasShareSnapshotSummary): CanvasShareResult {
  return decodeCanvasShareResult({ kind: "accepted", snapshot });
}

function denied(denialCode: CanvasShareDenialCode, message: string): CanvasShareResult {
  return decodeCanvasShareResult({ kind: "denied", denialCode, message });
}

function unavailable(denialCode: CanvasShareDenialCode, message: string): CanvasShareAccessResult {
  return decodeCanvasShareAccessResult({ kind: "unavailable", denialCode, message });
}
