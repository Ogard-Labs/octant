import { Schema } from "effect";
import {
  EventActor,
  UtcTimestamp,
  decodeWorkResearchBrief,
  decodeWorkResearchBriefId,
  decodeWorkResearchCommandResult,
  decodeWorkResearchFrame,
  decodeWorkResearchRequestId,
  decodeWorkSourceId,
  type WorkResearchBrief,
  type WorkResearchBriefId,
  type WorkResearchCommand,
  type WorkResearchCommandResult,
  type WorkResearchFrame,
  type WorkResearchRequestId,
  type WorkSourceId,
  type WorkSourceKind,
  type WorkSourceRecord,
  type ProjectId,
} from "@octant/contracts";
import {
  classifyEvidenceLeakage,
  classifyResearchAuthority,
  classifySourceFreshness,
  detectDuplicateSource,
  isClaimUnsupported,
  nextBriefStatus,
} from "@octant/domain";
import { WorkResearchEventStoreError } from "./workResearchEventStore";
import type { WorkResearchProjection } from "./workResearchProjection";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeResult = decodeWorkResearchCommandResult;

/**
 * Produce the next brief snapshot by merging a patch into the current brief
 * and re-decoding so the branded `version` and `status` fields stay valid.
 * The version increment is supplied as a plain number; decode brands it.
 */
function reviseBrief(brief: WorkResearchBrief, patch: Record<string, unknown>): WorkResearchBrief {
  return decodeWorkResearchBrief({ ...brief, ...patch });
}

/**
 * Verdict on one excerpt against the confined bytes the port read. The version
 * is observed from the same read as the verdict, so freshness and excerpt
 * support always describe the same bytes. `unverifiable` covers every source
 * this host cannot re-read as text — missing, unauthorized, oversize, binary,
 * or undecodable — and never means "supported".
 */
export type WorkResearchExcerptVerification =
  | {
      readonly outcome: "excerpt-present";
      readonly sourceVersion: import("@octant/contracts").PreviewSourceVersion;
    }
  | {
      readonly outcome: "excerpt-absent";
      readonly sourceVersion: import("@octant/contracts").PreviewSourceVersion;
    }
  | { readonly outcome: "unverifiable" };

/**
 * Read-only port the research service uses to observe a source's current
 * version for freshness classification and to check that a captured excerpt
 * really occurs in that source. The port never mutates an external system and
 * never returns a host path or any source content; it returns a
 * `PreviewSourceVersion` for the opaque source ref, `undefined` when the source
 * is unavailable, and a bounded excerpt verdict. Keeping the bytes inside the
 * port is what lets evidence be verified without widening what the service —
 * and therefore the journal — can ever hold. Implementations enforce
 * read-only, explicitly authorized, bounded access.
 */
export interface WorkResearchSourcePort {
  observeSourceVersion(input: {
    readonly projectId: ProjectId;
    readonly sourceKind: WorkSourceKind;
    readonly sourceRef: string;
    readonly signal?: AbortSignal;
  }): Promise<
    { readonly sourceVersion: import("@octant/contracts").PreviewSourceVersion } | undefined
  >;
  verifySourceExcerpt(input: {
    readonly projectId: ProjectId;
    readonly sourceKind: WorkSourceKind;
    readonly sourceRef: string;
    readonly excerpt: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkResearchExcerptVerification>;
}

export interface WorkResearchEventStorePort {
  append(input: {
    readonly briefId: WorkResearchBriefId;
    readonly expectedVersion: number;
    readonly frame: WorkResearchFrame;
  }): WorkResearchFrame;
  replayAll():
    | { readonly status: "ok"; readonly frames: ReadonlyArray<WorkResearchFrame> }
    | { readonly status: "snapshot-required"; readonly reason: "scan-limit" };
}

export interface WorkResearchServiceOptions {
  readonly projection: WorkResearchProjection;
  readonly eventStore: WorkResearchEventStorePort;
  readonly sources: WorkResearchSourcePort;
  readonly actor: typeof EventActor.Type;
  readonly clock: () => string;
}

function unauthorized(
  requestId: WorkResearchRequestId,
  briefId?: WorkResearchBriefId,
  sourceId?: WorkSourceId,
): WorkResearchCommandResult {
  return decodeResult({
    kind: "unauthorized",
    requestId,
    ...(briefId !== undefined ? { briefId } : {}),
    ...(sourceId !== undefined ? { sourceId } : {}),
  });
}

function notFound(
  requestId: WorkResearchRequestId,
  briefId?: WorkResearchBriefId,
  sourceId?: WorkSourceId,
): WorkResearchCommandResult {
  return decodeResult({
    kind: "not-found",
    requestId,
    ...(briefId !== undefined ? { briefId } : {}),
    ...(sourceId !== undefined ? { sourceId } : {}),
  });
}

function interrupted(
  requestId: WorkResearchRequestId,
  canRetry: boolean,
  briefId?: WorkResearchBriefId,
  sourceId?: WorkSourceId,
): WorkResearchCommandResult {
  return decodeResult({
    kind: "interrupted",
    requestId,
    canRetry,
    ...(briefId !== undefined ? { briefId } : {}),
    ...(sourceId !== undefined ? { sourceId } : {}),
  });
}

function failed(
  requestId: WorkResearchRequestId,
  reason: import("@octant/contracts").WorkResearchFailureCode,
  message?: string,
): WorkResearchCommandResult {
  return decodeResult({
    kind: "failed",
    requestId,
    reason,
    ...(message !== undefined ? { message } : {}),
  });
}

function conflict(
  requestId: WorkResearchRequestId,
  briefId?: WorkResearchBriefId,
  sourceId?: WorkSourceId,
): WorkResearchCommandResult {
  return decodeResult({
    kind: "conflict",
    requestId,
    ...(briefId !== undefined ? { briefId } : {}),
    ...(sourceId !== undefined ? { sourceId } : {}),
  });
}

function stale(
  requestId: WorkResearchRequestId,
  briefId: WorkResearchBriefId,
  sourceId?: WorkSourceId,
): WorkResearchCommandResult {
  return decodeResult({
    kind: "stale",
    requestId,
    briefId,
    ...(sourceId !== undefined ? { sourceId } : {}),
  });
}

function unsupported(
  requestId: WorkResearchRequestId,
  sourceKind?: WorkSourceKind,
): WorkResearchCommandResult {
  return decodeResult({
    kind: "unsupported",
    requestId,
    ...(sourceKind !== undefined ? { sourceKind } : {}),
  });
}

/**
 * Server-authoritative Work research service. Validates each command
 * against the pure provenance policy, enforces source-policy budgets,
 * retrieves sources read-only through the source port, journals each
 * successful transition as a versioned `work.research-recorded@1` event,
 * applies it to the projection, and returns a sanitized typed result (no
 * host path, no credential, no authority token). Cancellation via
 * `AbortSignal` fails closed as `interrupted` without partial state. Revoked
 * authority fails closed as `unauthorized` with only opaque ids.
 */
export class WorkResearchService {
  readonly #projection: WorkResearchProjection;
  readonly #eventStore: WorkResearchEventStorePort;
  readonly #sources: WorkResearchSourcePort;
  readonly #actor: typeof EventActor.Type;
  readonly #clock: () => string;

  constructor(options: WorkResearchServiceOptions) {
    this.#projection = options.projection;
    this.#eventStore = options.eventStore;
    this.#sources = options.sources;
    this.#actor = options.actor;
    this.#clock = options.clock;
  }

  /** Hydrate the projection from the authoritative journal after restart. */
  hydrate(): { readonly status: "ok" } | { readonly status: "snapshot-required" } {
    const replay = this.#eventStore.replayAll();
    if (replay.status === "snapshot-required") {
      return { status: "snapshot-required" };
    }
    for (const frame of replay.frames) {
      this.#projection.apply(frame);
    }
    return { status: "ok" };
  }

  async execute(
    command: WorkResearchCommand,
    options?: { readonly signal?: AbortSignal },
  ): Promise<WorkResearchCommandResult> {
    const requestId = decodeWorkResearchRequestId(command.requestId);
    try {
      switch (command.kind) {
        case "create-brief":
          return this.#createBrief(command, requestId);
        case "add-source":
          return await this.#addSource(command, requestId, options?.signal);
        case "revoke-source":
          return this.#revokeSource(command, requestId);
        case "record-evidence":
          return await this.#recordEvidence(command, requestId, options?.signal);
        case "record-claim":
          return this.#recordClaim(command, requestId);
        case "finalize-report":
          return this.#finalizeReport(command, requestId);
        case "cancel-retrieval":
          return this.#cancelRetrieval(command, requestId);
      }
    } catch (error) {
      if (error instanceof WorkResearchEventStoreError) {
        if (error.category === "invalid") {
          return conflict(requestId, command.briefId);
        }
        return failed(requestId, "failed");
      }
      throw error;
    }
  }

  /**
   * Resolve a stored brief only when it belongs to the command's authorized
   * Project. A brief owned by another Project is reported exactly like an
   * unknown brief, so a window authorized for Project A can neither mutate
   * nor confirm the existence of Project B's research. The check runs before
   * every other brief validation so a cross-Project caller cannot probe the
   * brief's version or status through `stale`/`unauthorized` responses.
   */
  #lookupAuthorizedEntry(
    briefId: WorkResearchBriefId,
    projectId: ProjectId,
  ): ReturnType<WorkResearchProjection["lookup"]> {
    const entry = this.#projection.lookup(briefId);
    if (entry === undefined || entry.brief.projectId !== projectId) return undefined;
    return entry;
  }

  #createBrief(
    command: Extract<WorkResearchCommand, { kind: "create-brief" }>,
    requestId: WorkResearchRequestId,
  ): WorkResearchCommandResult {
    const briefId = decodeWorkResearchBriefId(command.briefId);
    if (this.#projection.lookup(briefId) !== undefined) {
      return conflict(requestId, briefId);
    }
    const now = decodeTimestamp(this.#clock());
    const version = 1;
    const brief = decodeWorkResearchBrief({
      briefId,
      projectId: command.projectId,
      questions: command.questions,
      sourcePolicy: command.sourcePolicy,
      notes: [],
      deliverables: command.deliverables,
      status: "draft",
      createdBy: this.#actor,
      createdAt: now,
      version,
    });
    const frame = decodeWorkResearchFrame({
      requestId,
      projectId: command.projectId,
      sequence: version,
      occurredAt: now,
      transition: { kind: "brief-created", brief },
    });
    this.#eventStore.append({ briefId, expectedVersion: 0, frame });
    this.#projection.apply(frame);
    return decodeResult({ kind: "brief-created", requestId, brief });
  }

  async #addSource(
    command: Extract<WorkResearchCommand, { kind: "add-source" }>,
    requestId: WorkResearchRequestId,
    signal?: AbortSignal,
  ): Promise<WorkResearchCommandResult> {
    const briefId = decodeWorkResearchBriefId(command.briefId);
    const entry = this.#lookupAuthorizedEntry(briefId, command.projectId);
    const brief = entry?.brief;
    if (brief !== undefined && command.expectedVersion !== brief.version) {
      return stale(requestId, briefId, decodeWorkSourceId(command.sourceId));
    }
    const recordedSources = entry ? [...entry.sources.values()] : [];
    const authority = classifyResearchAuthority({
      brief,
      recordedSourceCount: recordedSources.length,
      candidateSourceKind: command.sourceKind,
      candidateAvailability: "fresh",
      isExistingSource: false,
    });
    if (authority.kind === "denied") {
      return this.#authorityFailure(authority.reason, requestId, command);
    }
    // After the authority check, a denied `brief-not-found` would have
    // returned; if we reach this point the brief exists in the authorized
    // Project (the lookup already bound it to `command.projectId`).
    const resolvedBrief = brief as WorkResearchBrief;
    if (
      detectDuplicateSource(
        recordedSources.map((source) => ({ kind: source.kind, sourceRef: source.sourceRef })),
        { kind: command.sourceKind, sourceRef: command.sourceRef },
      )
    ) {
      return conflict(requestId, briefId, decodeWorkSourceId(command.sourceId));
    }

    // Read-only freshness observation through the explicit source port.
    let observed:
      | { readonly sourceVersion: import("@octant/contracts").PreviewSourceVersion }
      | undefined;
    try {
      observed = await this.#sources.observeSourceVersion({
        projectId: command.projectId,
        sourceKind: command.sourceKind,
        sourceRef: command.sourceRef,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch {
      return interrupted(requestId, true, briefId, decodeWorkSourceId(command.sourceId));
    }
    if (signal?.aborted) {
      return interrupted(requestId, true, briefId, decodeWorkSourceId(command.sourceId));
    }
    const freshness = classifySourceFreshness({
      known: command.sourceVersion,
      current: observed?.sourceVersion,
    });
    if (freshness === "unavailable") {
      return unsupported(requestId, command.sourceKind);
    }
    if (freshness === "stale") {
      return stale(requestId, briefId, decodeWorkSourceId(command.sourceId));
    }
    if (classifyEvidenceLeakage(command.excerpt) === "leaked") {
      return unauthorized(requestId, briefId, decodeWorkSourceId(command.sourceId));
    }

    const now = decodeTimestamp(this.#clock());
    const nextVersion = resolvedBrief.version + 1;
    const nextStatus = nextBriefStatus(resolvedBrief.status, "source-added");
    const updatedBrief = reviseBrief(resolvedBrief, { status: nextStatus, version: nextVersion });
    const source: WorkSourceRecord = {
      sourceId: decodeWorkSourceId(command.sourceId),
      briefId,
      projectId: command.projectId,
      kind: command.sourceKind,
      sourceRef: command.sourceRef,
      displayName: command.displayName,
      retrievedAt: now,
      excerpt: command.excerpt,
      citationAnchor: command.citationAnchor,
      sourceVersion: command.sourceVersion,
      availability: "fresh",
    };
    const frame = decodeWorkResearchFrame({
      requestId,
      projectId: command.projectId,
      sequence: nextVersion,
      occurredAt: now,
      transition: { kind: "source-added", brief: updatedBrief, source },
    });
    this.#eventStore.append({ briefId, expectedVersion: resolvedBrief.version, frame });
    this.#projection.apply(frame);
    return decodeResult({ kind: "source-added", requestId, brief: updatedBrief, source });
  }

  #revokeSource(
    command: Extract<WorkResearchCommand, { kind: "revoke-source" }>,
    requestId: WorkResearchRequestId,
  ): WorkResearchCommandResult {
    const briefId = decodeWorkResearchBriefId(command.briefId);
    const sourceId = decodeWorkSourceId(command.sourceId);
    const entry = this.#lookupAuthorizedEntry(briefId, command.projectId);
    if (entry === undefined) return notFound(requestId, briefId, sourceId);
    if (command.expectedVersion !== entry.brief.version) {
      return stale(requestId, briefId, sourceId);
    }
    if (entry.brief.status === "finalized" || entry.brief.status === "cancelled") {
      return unauthorized(requestId, briefId, sourceId);
    }
    if (!entry.sources.has(sourceId)) return notFound(requestId, briefId, sourceId);
    const now = decodeTimestamp(this.#clock());
    const nextVersion = entry.brief.version + 1;
    const updatedBrief = reviseBrief(entry.brief, { version: nextVersion });
    const frame = decodeWorkResearchFrame({
      requestId,
      projectId: entry.brief.projectId,
      sequence: nextVersion,
      occurredAt: now,
      transition: { kind: "source-revoked", brief: updatedBrief, sourceId },
    });
    this.#eventStore.append({ briefId, expectedVersion: entry.brief.version, frame });
    this.#projection.apply(frame);
    return decodeResult({ kind: "source-revoked", requestId, brief: updatedBrief, sourceId });
  }

  async #recordEvidence(
    command: Extract<WorkResearchCommand, { kind: "record-evidence" }>,
    requestId: WorkResearchRequestId,
    signal?: AbortSignal,
  ): Promise<WorkResearchCommandResult> {
    const briefId = decodeWorkResearchBriefId(command.briefId);
    const sourceId = decodeWorkSourceId(command.sourceId);
    const entry = this.#lookupAuthorizedEntry(briefId, command.projectId);
    if (entry === undefined) return notFound(requestId, briefId, sourceId);
    if (command.expectedVersion !== entry.brief.version) {
      return stale(requestId, briefId, sourceId);
    }
    if (entry.brief.status === "finalized" || entry.brief.status === "cancelled") {
      return unauthorized(requestId, briefId, sourceId);
    }
    const source = entry.sources.get(sourceId);
    if (source === undefined) return notFound(requestId, briefId, sourceId);
    if (source.availability !== "fresh") {
      return unauthorized(requestId, briefId, sourceId);
    }
    if (classifyEvidenceLeakage(command.excerpt) === "leaked") {
      return unauthorized(requestId, briefId, sourceId);
    }

    // The projected availability was captured at add-source, and the excerpt is
    // whatever the caller typed. Re-read the confined source through the same
    // read-only port so evidence is never journaled as source-backed after the
    // source changed or disappeared, nor when the source never said it. One
    // read answers both questions, so the version and the excerpt verdict
    // always describe the same bytes.
    let verification: WorkResearchExcerptVerification;
    try {
      verification = await this.#sources.verifySourceExcerpt({
        projectId: entry.brief.projectId,
        sourceKind: source.kind,
        sourceRef: source.sourceRef,
        excerpt: command.excerpt,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch {
      return interrupted(requestId, true, briefId, sourceId);
    }
    if (signal?.aborted) {
      return interrupted(requestId, true, briefId, sourceId);
    }
    const freshness = classifySourceFreshness({
      known: source.sourceVersion,
      current: verification.outcome === "unverifiable" ? undefined : verification.sourceVersion,
    });
    // The success-transition contract has no availability-change kind, so a
    // failed re-observation rejects without journaling and the projection
    // keeps the availability captured at add-source. Follow-up: extend the
    // contract with an availability transition so a rejected re-observation
    // can mark the source stale/unavailable in the projection.
    if (freshness === "unavailable") {
      // Also the honest answer for a binary or undecodable source: this host
      // cannot read it as text, so it can support no excerpt at all.
      return unsupported(requestId, source.kind);
    }
    if (freshness === "stale") {
      return stale(requestId, briefId, sourceId);
    }
    if (verification.outcome === "excerpt-absent") {
      // The source is present and unchanged, and it does not contain this
      // text. Refusing is the provenance guarantee working, so say so plainly
      // rather than implying the source or the brief is at fault.
      return failed(requestId, "invalid", "This excerpt was not found in the source.");
    }

    const now = decodeTimestamp(this.#clock());
    const nextVersion = entry.brief.version + 1;
    const nextStatus = nextBriefStatus(entry.brief.status, "evidence-recorded");
    const updatedBrief = reviseBrief(entry.brief, { status: nextStatus, version: nextVersion });
    const evidence = {
      evidenceId: command.evidenceId,
      briefId,
      sourceId,
      citationAnchor: command.citationAnchor,
      excerpt: command.excerpt,
      retrievedAt: command.retrievedAt,
    };
    const frame = decodeWorkResearchFrame({
      requestId,
      projectId: entry.brief.projectId,
      sequence: nextVersion,
      occurredAt: now,
      transition: { kind: "evidence-recorded", brief: updatedBrief, evidence },
    });
    this.#eventStore.append({ briefId, expectedVersion: entry.brief.version, frame });
    this.#projection.apply(frame);
    return decodeResult({ kind: "evidence-recorded", requestId, brief: updatedBrief, evidence });
  }

  #recordClaim(
    command: Extract<WorkResearchCommand, { kind: "record-claim" }>,
    requestId: WorkResearchRequestId,
  ): WorkResearchCommandResult {
    const briefId = decodeWorkResearchBriefId(command.briefId);
    const entry = this.#lookupAuthorizedEntry(briefId, command.projectId);
    if (entry === undefined) return notFound(requestId, briefId);
    if (command.expectedVersion !== entry.brief.version) {
      return stale(requestId, briefId);
    }
    if (entry.brief.status === "finalized" || entry.brief.status === "cancelled") {
      return unauthorized(requestId, briefId);
    }
    const unsupportedClaim = isClaimUnsupported({
      evidence: entry.evidence.map((entry2) => ({
        citationAnchor: entry2.citationAnchor,
        sourceId: entry2.sourceId,
      })),
      sources: [...entry.sources.values()].map((source) => ({
        sourceId: source.sourceId,
        availability: source.availability,
      })),
      claim: { citationAnchors: command.citationAnchors },
    });
    const now = decodeTimestamp(this.#clock());
    const nextVersion = entry.brief.version + 1;
    const nextStatus = nextBriefStatus(entry.brief.status, "claim-recorded");
    const updatedBrief = reviseBrief(entry.brief, { status: nextStatus, version: nextVersion });
    const claim = {
      claimId: command.claimId,
      briefId,
      text: command.text,
      citationAnchors: command.citationAnchors,
      unsupported: unsupportedClaim,
    };
    const frame = decodeWorkResearchFrame({
      requestId,
      projectId: entry.brief.projectId,
      sequence: nextVersion,
      occurredAt: now,
      transition: { kind: "claim-recorded", brief: updatedBrief, claim },
    });
    this.#eventStore.append({ briefId, expectedVersion: entry.brief.version, frame });
    this.#projection.apply(frame);
    return decodeResult({ kind: "claim-recorded", requestId, brief: updatedBrief, claim });
  }

  #finalizeReport(
    command: Extract<WorkResearchCommand, { kind: "finalize-report" }>,
    requestId: WorkResearchRequestId,
  ): WorkResearchCommandResult {
    const briefId = decodeWorkResearchBriefId(command.briefId);
    const entry = this.#lookupAuthorizedEntry(briefId, command.projectId);
    if (entry === undefined) return notFound(requestId, briefId);
    if (command.expectedVersion !== entry.brief.version) {
      return stale(requestId, briefId);
    }
    if (entry.brief.status === "finalized" || entry.brief.status === "cancelled") {
      return unauthorized(requestId, briefId);
    }
    const now = decodeTimestamp(this.#clock());
    const nextVersion = entry.brief.version + 1;
    const updatedBrief = reviseBrief(entry.brief, { status: "finalized", version: nextVersion });
    const report = {
      reportId: command.reportId,
      briefId,
      projectId: entry.brief.projectId,
      evidence: [...entry.evidence],
      claims: [...entry.claims],
      producedArtifactRef: command.producedArtifactRef,
      finalizedAt: now,
    };
    const frame = decodeWorkResearchFrame({
      requestId,
      projectId: entry.brief.projectId,
      sequence: nextVersion,
      occurredAt: now,
      transition: { kind: "report-finalized", brief: updatedBrief, report },
    });
    this.#eventStore.append({ briefId, expectedVersion: entry.brief.version, frame });
    this.#projection.apply(frame);
    return decodeResult({ kind: "report-finalized", requestId, brief: updatedBrief, report });
  }

  #cancelRetrieval(
    command: Extract<WorkResearchCommand, { kind: "cancel-retrieval" }>,
    requestId: WorkResearchRequestId,
  ): WorkResearchCommandResult {
    const briefId = decodeWorkResearchBriefId(command.briefId);
    const sourceId = decodeWorkSourceId(command.sourceId);
    const entry = this.#lookupAuthorizedEntry(briefId, command.projectId);
    if (entry === undefined) return notFound(requestId, briefId, sourceId);
    if (command.expectedVersion !== entry.brief.version) {
      return stale(requestId, briefId, sourceId);
    }
    if (entry.brief.status === "finalized" || entry.brief.status === "cancelled") {
      return unauthorized(requestId, briefId, sourceId);
    }
    const now = decodeTimestamp(this.#clock());
    const nextVersion = entry.brief.version + 1;
    const updatedBrief = reviseBrief(entry.brief, { version: nextVersion });
    const frame = decodeWorkResearchFrame({
      requestId,
      projectId: entry.brief.projectId,
      sequence: nextVersion,
      occurredAt: now,
      transition: { kind: "retrieval-cancelled", brief: updatedBrief, sourceId },
    });
    this.#eventStore.append({ briefId, expectedVersion: entry.brief.version, frame });
    this.#projection.apply(frame);
    return decodeResult({ kind: "retrieval-cancelled", requestId, brief: updatedBrief, sourceId });
  }

  #authorityFailure(
    reason:
      | "source-revoked"
      | "source-stale"
      | "source-unavailable"
      | "source-kind-not-allowed"
      | "source-outside-brief"
      | "source-budget-exceeded"
      | "brief-not-found"
      | "brief-finalized"
      | "brief-cancelled",
    requestId: WorkResearchRequestId,
    command: Extract<WorkResearchCommand, { kind: "add-source" }>,
  ): WorkResearchCommandResult {
    const briefId = decodeWorkResearchBriefId(command.briefId);
    const sourceId = decodeWorkSourceId(command.sourceId);
    switch (reason) {
      case "brief-not-found":
        return notFound(requestId, briefId, sourceId);
      case "brief-finalized":
      case "brief-cancelled":
      case "source-revoked":
        return unauthorized(requestId, briefId, sourceId);
      case "source-kind-not-allowed":
        return unsupported(requestId, command.sourceKind);
      case "source-budget-exceeded":
        return conflict(requestId, briefId, sourceId);
      case "source-stale":
        return stale(requestId, briefId, sourceId);
      case "source-unavailable":
        return unsupported(requestId, command.sourceKind);
      case "source-outside-brief":
        return unauthorized(requestId, briefId, sourceId);
    }
  }
}
