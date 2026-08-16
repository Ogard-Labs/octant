import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  ActorId,
  ContentSha256,
  EventActor,
  PreviewHostId,
  PreviewTarget,
  UtcTimestamp,
  decodeWorkArtifactId,
  decodeWorkArtifactRef,
  decodeWorkArtifactVersionId,
  type WorkArtifactFormat,
  type WorkArtifactId,
  type WorkArtifactIdentity,
  type WorkArtifactMutationFrame,
  type WorkArtifactVersion,
  type WorkCapabilityReport,
  type WorkExportHandoff,
  type WorkMutationOutcome,
  WorkMutationReply,
  type WorkMutationRequest,
  type WorkMutationSuccessOutcome,
  type ProjectId,
  type PreviewSourceVersion,
} from "@octant/contracts";
import {
  canonicalizeWorkRelativePath,
  classifyDestructiveChange,
  classifyMutationAuthority,
  detectMovedRoot,
  detectRevokedRoot,
  type WorkMutationPosture,
} from "@octant/domain";
import { readConfinedWorkFile } from "./workConfinedRead";
import type { WorkFileIdentity, WorkFileStat, WorkFilesystemPort } from "./workFilesystemPort";
import { WorkResolutionService, type WorkRootBinding } from "./workResolutionService";
import type { WorkArtifactProjection } from "./workArtifactProjection";
import { baseWorkCapabilityReport } from "./workCapabilityCatalog";
import {
  MAX_WORK_INPUT_BYTES,
  validateWorkInputBudget,
  validateWorkDisplayNameBudget,
  validateWorkOutputBudget,
} from "./workBudget";
import {
  WorkAdapterBudgetError,
  WorkAdapterUnsupportedInputError,
  getWorkFormatAdapter,
} from "./workFormatAdapter";
import "./workFormatAdapters";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeSha256 = Schema.decodeUnknownSync(ContentSha256);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeHostId = Schema.decodeUnknownSync(PreviewHostId);
const decodePreviewTarget = Schema.decodeUnknownSync(PreviewTarget);
const decodeReply = Schema.decodeUnknownSync(WorkMutationReply);
const decodeDisplayName = (value: string): string => value;

/**
 * Export formats whose adapters declare external-application handoff. A
 * same-format export to one of these formats materializes the file and hands
 * it to the native host (Finder reveal / Quick Look / open-external) through
 * an opaque `external-handoff` export ref instead of an in-app preview
 * version. All other export formats keep the in-app preview version handoff.
 */
const EXTERNAL_HANDOFF_EXPORT_FORMATS: ReadonlySet<WorkArtifactFormat> = new Set([
  "docx",
  "pdf",
  "image",
]);

export interface WorkMutationContext {
  readonly binding: WorkRootBinding;
  readonly posture: WorkMutationPosture;
  readonly approved: boolean;
  readonly signal?: AbortSignal;
}

export interface WorkMutationEventStorePort {
  append(input: {
    readonly artifactId: WorkArtifactId;
    readonly expectedSequence: number;
    readonly frame: WorkArtifactMutationFrame;
  }): WorkArtifactMutationFrame;
  replay(input: {
    readonly artifactId: WorkArtifactId;
    readonly afterSequence: number;
    readonly limit: number;
  }):
    | {
        readonly status: "ok";
        readonly frames: ReadonlyArray<WorkArtifactMutationFrame>;
        readonly nextCursor: number;
      }
    | { readonly status: "snapshot-required"; readonly reason: string };
}

export interface WorkMutationServiceOptions {
  readonly filesystem: WorkFilesystemPort;
  readonly resolution: WorkResolutionService;
  readonly projection: WorkArtifactProjection;
  readonly eventStore: WorkMutationEventStorePort;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly actor: typeof EventActor.Type;
  readonly hostId: typeof PreviewHostId.Type;
}

type UnauthorizedReason =
  | "revoked-root"
  | "moved-root"
  | "escapes-root"
  | "symlink-escape"
  | "unknown-artifact"
  | "approval-required"
  | "authority-denied";

/**
 * Server-authoritative Work mutation service. Resolves opaque artifact
 * references inside the bound Project root, re-runs confinement authority
 * (canonicalization, symlink containment, moved-root, revoked-root,
 * stale-source) before every side effect, enforces input/output budgets,
 * journals each successful mutation as a versioned event, applies it to the
 * rebuildable projection, and returns a sanitized reply (no host path, no
 * credential, no authority token). Cancellation via `AbortSignal` fails
 * closed as `interrupted` without leaving partial state. Unsupported formats
 * and unsupported transform/export targets fail closed as `unsupported`.
 */
export class WorkMutationService {
  readonly #filesystem: WorkFilesystemPort;
  readonly #resolution: WorkResolutionService;
  readonly #projection: WorkArtifactProjection;
  readonly #eventStore: WorkMutationEventStorePort;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #actor: typeof EventActor.Type;
  readonly #hostId: typeof PreviewHostId.Type;

  constructor(options: WorkMutationServiceOptions) {
    this.#filesystem = options.filesystem;
    this.#resolution = options.resolution;
    this.#projection = options.projection;
    this.#eventStore = options.eventStore;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    try {
      this.#actor = decodeActor(options.actor);
      decodeActorId(this.#actor.actorId);
      this.#hostId = decodeHostId(options.hostId);
    } catch {
      throw new Error("WorkMutationService: actor or host id is invalid.");
    }
  }

  async mutate(
    request: WorkMutationRequest,
    context: WorkMutationContext,
  ): Promise<WorkMutationReply> {
    if (context.signal?.aborted) return interruptedReply(request);
    switch (request.kind) {
      case "create-artifact":
        return this.#createArtifact(request, context);
      case "revise-artifact":
        return this.#reviseArtifact(request, context);
      case "transform-artifact":
        return this.#transformArtifact(request, context);
      case "rename-artifact":
        return this.#renameArtifact(request, context);
      case "delete-artifact":
        return this.#deleteArtifact(request, context);
      case "version-artifact":
        return this.#versionArtifact(request, context);
      case "export-artifact":
        return this.#exportArtifact(request, context);
    }
  }

  async #createArtifact(
    request: Extract<WorkMutationRequest, { kind: "create-artifact" }>,
    context: WorkMutationContext,
  ): Promise<WorkMutationReply> {
    const adapter = getWorkFormatAdapter(request.format);
    if (adapter === undefined) {
      return unsupportedReply(request, request.format);
    }
    const capability = baseWorkCapabilityReport(request.format);
    const budgetRejection =
      validateWorkInputBudget(request.content) ??
      validateWorkDisplayNameBudget(request.displayName);
    if (budgetRejection !== undefined) {
      return failedReply(request, "oversize");
    }
    if (context.signal?.aborted) return interruptedReply(request);

    let relativePath: string;
    try {
      relativePath = canonicalizeWorkRelativePath(request.displayName);
    } catch {
      return unauthorizedReply(request, "escapes-root");
    }

    const resolution = await this.#resolution.resolveForCreate({
      binding: context.binding,
      relativePath,
    });
    if (resolution.status !== "resolved-for-create") {
      return unauthorizedReply(request, resolution.status);
    }
    if (context.signal?.aborted) return interruptedReply(request);

    const authority = classifyMutationAuthority({
      posture: context.posture,
      mutationKind: "create",
      capability,
      change: classifyDestructiveChange({ kind: "create" }),
      rootRevocation: detectRevokedRoot({
        availability: context.binding.availability,
        bindingSuperseded: context.binding.bindingSuperseded,
      }),
      pathContainment: "contained",
      rootMoved: detectMovedRoot(
        { canonicalRoot: context.binding.canonicalRoot },
        { canonicalRoot: context.binding.knownCanonicalRoot },
      ),
      sourceAvailability: "available",
    });
    if (authority === "deny") return unauthorizedReply(request, "authority-denied");
    if (authority === "needs-approval" && !context.approved) {
      return unauthorizedReply(request, "approval-required");
    }

    const artifactId = decodeWorkArtifactId(this.#uuid());
    const versionId = decodeWorkArtifactVersionId(this.#uuid());
    const artifactRef = decodeWorkArtifactRef(this.#uuid());
    const occurredAt = decodeTimestamp(this.#clock());
    let bytes: Uint8Array;
    try {
      bytes = adapter.encode(request.content);
    } catch (error) {
      if (error instanceof WorkAdapterBudgetError) return failedReply(request, "oversize");
      if (error instanceof WorkAdapterUnsupportedInputError) {
        return unsupportedReply(request, request.format);
      }
      return failedReply(request, "parse-failed");
    }
    const outputRejection = validateWorkOutputBudget(bytes.byteLength);
    if (outputRejection !== undefined) return failedReply(request, "oversize");
    const sourceVersion = computeSourceVersion(bytes, occurredAt);

    try {
      await this.#filesystem.writeFile(resolution.absolutePath, bytes);
    } catch {
      return failedReply(request, "write-failed");
    }
    if (context.signal?.aborted) return interruptedReply(request);

    const artifact: WorkArtifactIdentity = {
      artifactId,
      projectId: request.projectId,
      format: request.format,
      artifactRef,
      displayName: decodeDisplayName(request.displayName),
      createdAt: occurredAt,
    };
    const version: WorkArtifactVersion = {
      versionId,
      artifactId,
      projectId: request.projectId,
      format: request.format,
      sourceVersion,
      createdBy: this.#actor,
      createdAt: occurredAt,
      sequence: 1,
    };
    const previewTarget = this.#previewTarget(artifact, occurredAt);
    const outcome: WorkMutationSuccessOutcome = {
      kind: "created",
      artifact,
      version,
      previewTarget,
    };
    const frame = this.#buildFrame(request, request.projectId, 1, occurredAt, outcome);
    try {
      this.#eventStore.append({ artifactId, expectedSequence: 0, frame });
    } catch {
      return failedReply(request, "write-failed");
    }
    this.#projection.apply(frame);
    return successReply(request, outcome, capability);
  }

  async #reviseArtifact(
    request: Extract<WorkMutationRequest, { kind: "revise-artifact" }>,
    context: WorkMutationContext,
  ): Promise<WorkMutationReply> {
    const entry = this.#projection.lookup(request.artifactId);
    if (entry === undefined || entry.deleted) {
      return unauthorizedReply(request, "unknown-artifact");
    }
    if (entry.sequence !== request.expectedArtifactVersion) {
      return staleReply(request, entry.currentSourceVersion);
    }
    const adapter = getWorkFormatAdapter(entry.format);
    if (adapter === undefined) {
      return unsupportedReply(request, entry.format, request.artifactId);
    }
    const capability = baseWorkCapabilityReport(entry.format);
    const budgetRejection = validateWorkInputBudget(request.content);
    if (budgetRejection !== undefined) return failedReply(request, "oversize");
    if (context.signal?.aborted) return interruptedReply(request);

    const resolution = await this.#resolution.resolve({
      binding: context.binding,
      relativePath: entry.relativePath,
      knownVersion: entry.currentSourceVersion,
    });
    const resolutionFailure = mapResolutionFailure(request, resolution);
    if (resolutionFailure !== undefined) return resolutionFailure;
    if (context.signal?.aborted) return interruptedReply(request);
    const resolved = resolution as Extract<typeof resolution, { status: "resolved" }>;

    const authority = classifyMutationAuthority({
      posture: context.posture,
      mutationKind: "revise",
      capability,
      change: classifyDestructiveChange({ kind: "revise" }),
      rootRevocation: detectRevokedRoot({
        availability: context.binding.availability,
        bindingSuperseded: context.binding.bindingSuperseded,
      }),
      pathContainment: "contained",
      rootMoved: detectMovedRoot(
        { canonicalRoot: context.binding.canonicalRoot },
        { canonicalRoot: context.binding.knownCanonicalRoot },
      ),
      sourceAvailability: "available",
    });
    if (authority === "deny") return unauthorizedReply(request, "authority-denied");
    if (authority === "needs-approval" && !context.approved) {
      return unauthorizedReply(request, "approval-required");
    }

    let bytes: Uint8Array;
    try {
      bytes = adapter.encode(request.content);
    } catch (error) {
      if (error instanceof WorkAdapterBudgetError)
        return failedReply(request, "oversize", request.artifactId);
      if (error instanceof WorkAdapterUnsupportedInputError) {
        return unsupportedReply(request, entry.format, request.artifactId);
      }
      return failedReply(request, "parse-failed", request.artifactId);
    }
    const outputRejection = validateWorkOutputBudget(bytes.byteLength);
    if (outputRejection !== undefined) return failedReply(request, "oversize");
    try {
      await this.#filesystem.writeFile(resolved.absolutePath, bytes);
    } catch {
      return failedReply(request, "write-failed");
    }
    if (context.signal?.aborted) return interruptedReply(request);

    const sequence = entry.sequence + 1;
    const occurredAt = decodeTimestamp(this.#clock());
    const sourceVersion = computeSourceVersion(bytes, occurredAt);
    const versionId = decodeWorkArtifactVersionId(this.#uuid());
    const artifact: WorkArtifactIdentity = {
      artifactId: entry.artifactId,
      projectId: entry.projectId,
      format: entry.format,
      artifactRef: decodeWorkArtifactRef(entry.artifactRef),
      displayName: decodeDisplayName(entry.displayName),
      createdAt: decodeTimestamp(entry.currentSourceVersion.observedAt),
    };
    const version: WorkArtifactVersion = {
      versionId,
      artifactId: entry.artifactId,
      projectId: entry.projectId,
      format: entry.format,
      sourceVersion,
      createdBy: this.#actor,
      createdAt: occurredAt,
      sequence,
    };
    const previewTarget = this.#previewTarget(artifact, occurredAt);
    const outcome: WorkMutationSuccessOutcome = {
      kind: "revised",
      artifact,
      version,
      previewTarget,
    };
    return this.#commitSuccess(
      request,
      entry.artifactId,
      entry.sequence,
      sequence,
      occurredAt,
      outcome,
      capability,
    );
  }

  /**
   * Bytes of the object a resolution approved, proved to be that object.
   *
   * A mutation resolves, then evaluates authority, then reads — and the whole
   * evaluation sits between the containment proof and the read. Handing the
   * name back to the filesystem there would read whatever it means by the time
   * the mutation is allowed to proceed, so the read carries the identity the
   * resolution saw and refuses anything else. `undefined` is a refusal; there is
   * no second attempt and no partial result to trust.
   */
  async #readResolved(
    canonicalPath: string,
    expected: WorkFileIdentity,
  ): Promise<Uint8Array | undefined> {
    return await readConfinedWorkFile({
      filesystem: this.#filesystem,
      canonicalPath,
      expected,
      maximumBytes: MAX_WORK_INPUT_BYTES,
    });
  }

  /**
   * Bytes of whatever already answers to a path this mutation is about to
   * write, for the retry check that decides whether the write already happened.
   *
   * There is no earlier resolution to carry an identity from, so the object is
   * measured and read back to back. A path that is not a regular file — a
   * directory, or a link that would otherwise both answer the check and receive
   * the write — yields `undefined`, and every caller turns that into a refusal
   * rather than a write.
   */
  async #readExistingTarget(canonicalPath: string): Promise<Uint8Array | undefined> {
    let existing: WorkFileStat;
    try {
      existing = await this.#filesystem.stat(canonicalPath);
    } catch {
      return undefined;
    }
    if (!existing.isFile) return undefined;
    return await this.#readResolved(canonicalPath, existing);
  }

  async #transformArtifact(
    request: Extract<WorkMutationRequest, { kind: "transform-artifact" }>,
    context: WorkMutationContext,
  ): Promise<WorkMutationReply> {
    const entry = this.#projection.lookup(request.artifactId);
    if (entry === undefined || entry.deleted) {
      return unauthorizedReply(request, "unknown-artifact");
    }
    if (entry.sequence !== request.expectedArtifactVersion) {
      return staleReply(request, entry.currentSourceVersion);
    }
    const sourceAdapter = getWorkFormatAdapter(entry.format);
    if (sourceAdapter === undefined) {
      return unsupportedReply(request, entry.format, request.artifactId);
    }
    const capability = baseWorkCapabilityReport(entry.format);
    if (context.signal?.aborted) return interruptedReply(request);

    const resolution = await this.#resolution.resolve({
      binding: context.binding,
      relativePath: entry.relativePath,
      knownVersion: entry.currentSourceVersion,
    });
    const resolutionFailure = mapResolutionFailure(request, resolution);
    if (resolutionFailure !== undefined) return resolutionFailure;
    if (context.signal?.aborted) return interruptedReply(request);
    const resolved = resolution as Extract<typeof resolution, { status: "resolved" }>;

    const authority = classifyMutationAuthority({
      posture: context.posture,
      mutationKind: "transform",
      capability,
      change: classifyDestructiveChange({
        kind: "transform",
        format: entry.format,
        targetFormat: request.targetFormat,
      }),
      rootRevocation: detectRevokedRoot({
        availability: context.binding.availability,
        bindingSuperseded: context.binding.bindingSuperseded,
      }),
      pathContainment: "contained",
      rootMoved: detectMovedRoot(
        { canonicalRoot: context.binding.canonicalRoot },
        { canonicalRoot: context.binding.knownCanonicalRoot },
      ),
      sourceAvailability: "available",
      transformTarget: request.targetFormat,
    });
    if (authority === "deny")
      return unsupportedReply(request, request.targetFormat, request.artifactId);
    if (authority === "needs-approval" && !context.approved) {
      return unauthorizedReply(request, "approval-required");
    }

    const sourceBytes = await this.#readResolved(resolved.absolutePath, resolved.sourceIdentity);
    if (sourceBytes === undefined) return failedReply(request, "read-failed", request.artifactId);
    if (context.signal?.aborted) return interruptedReply(request);

    let targetBytes: Uint8Array | undefined;
    try {
      targetBytes = sourceAdapter.convertTo(request.targetFormat, sourceBytes);
    } catch (error) {
      if (error instanceof WorkAdapterBudgetError)
        return failedReply(request, "oversize", request.artifactId);
      return failedReply(request, "parse-failed", request.artifactId);
    }
    if (targetBytes === undefined) {
      return unsupportedReply(request, request.targetFormat, request.artifactId);
    }
    const outputRejection = validateWorkOutputBudget(targetBytes.byteLength);
    if (outputRejection !== undefined) return failedReply(request, "oversize", request.artifactId);
    if (context.signal?.aborted) return interruptedReply(request);

    const targetFormat = request.targetFormat;
    const isCrossFormat = targetFormat !== entry.format;
    const newDisplayName = isCrossFormat
      ? displayNameForTargetFormat(decodeDisplayName(entry.displayName), targetFormat)
      : decodeDisplayName(entry.displayName);

    // For a cross-format transform, resolve a new path under the target-format
    // display name. Check that the target path does not already exist so the
    // transform does not silently overwrite an unrelated file.
    let targetAbsolutePath: string;
    let targetBytesAlreadyWritten = false;
    let newResolutionForTransform:
      | Extract<
          Awaited<ReturnType<WorkResolutionService["resolveForCreate"]>>,
          { status: "resolved-for-create" }
        >
      | undefined;
    if (isCrossFormat) {
      const newRelativePath = canonicalizeWorkRelativePath(newDisplayName);
      const transformResolution = await this.#resolution.resolveForCreate({
        binding: context.binding,
        relativePath: newRelativePath,
      });
      if (transformResolution.status !== "resolved-for-create") {
        return unauthorizedReply(request, transformResolution.status, request.artifactId);
      }
      newResolutionForTransform = transformResolution;
      targetAbsolutePath = transformResolution.absolutePath;
      // If the target path is the same as the source path (e.g., markdown →
      // markdown-deck both use .md), treat it as an in-place update: skip the
      // existing-path guard and the old-file deletion.
      const samePath = targetAbsolutePath === resolved.absolutePath;
      if (!samePath) {
        // Reject if the target path already exists with DIFFERENT content.
        // If it exists with the SAME content, the write already happened in a
        // previous attempt that failed during journaling — proceed to journal
        // so the retry can complete (orphan cleanup).
        let targetPresent = true;
        try {
          await this.#filesystem.lstat(targetAbsolutePath);
        } catch {
          // Target path does not exist — proceed with write.
          targetPresent = false;
        }
        if (targetPresent) {
          // Something already answers to the target name, so it has to be read
          // as a contained regular file or refused. A file this mutation cannot
          // read is not one it may overwrite either.
          const existingBytes = await this.#readExistingTarget(targetAbsolutePath);
          if (existingBytes === undefined || !bytesEqual(existingBytes, targetBytes)) {
            // Genuinely conflicting or unreadable file — do not overwrite.
            return failedReply(request, "write-failed", request.artifactId);
          }
          // Content matches — this is a retry after a journal failure. Skip
          // the write and proceed to journal.
          targetBytesAlreadyWritten = true;
        }
      } else {
        // Same path: this is effectively an in-place format change (e.g.,
        // markdown → markdown-deck). Don't delete the old file afterward.
        newResolutionForTransform = undefined;
      }
    } else {
      targetAbsolutePath = resolved.absolutePath;
    }
    if (context.signal?.aborted) return interruptedReply(request);

    // Write the converted bytes before journaling so a write failure leaves
    // the journal/projection unchanged and the client can retry without a
    // version conflict. If the journal fails after the write, the file has
    // new content but the projection is stale; the next mutation detects the
    // content-hash mismatch and surfaces it as stale, providing a recovery
    // path. This is the safer failure mode than journaling first (which would
    // advance the sequence on a write failure and block retries).
    if (!targetBytesAlreadyWritten) {
      try {
        await this.#filesystem.writeFile(targetAbsolutePath, targetBytes);
      } catch {
        return failedReply(request, "write-failed", request.artifactId);
      }
    }
    // After the write succeeds, check for abort before journaling. If the
    // signal was aborted during the write, the file has new content but the
    // journal has not advanced — the next mutation will detect the content
    // mismatch and surface it as stale. Return interrupted so the client
    // knows the operation did not complete; the client can retry and the
    // retry will recognize the already-written bytes (orphan cleanup).
    if (context.signal?.aborted) return interruptedReply(request);

    const sequence = entry.sequence + 1;
    const occurredAt = decodeTimestamp(this.#clock());
    const sourceVersion = computeSourceVersion(targetBytes, occurredAt);
    const versionId = decodeWorkArtifactVersionId(this.#uuid());
    const artifact: WorkArtifactIdentity = {
      artifactId: entry.artifactId,
      projectId: entry.projectId,
      format: targetFormat,
      artifactRef: decodeWorkArtifactRef(entry.artifactRef),
      displayName: newDisplayName,
      createdAt: decodeTimestamp(entry.currentSourceVersion.observedAt),
    };
    const version: WorkArtifactVersion = {
      versionId,
      artifactId: entry.artifactId,
      projectId: entry.projectId,
      format: targetFormat,
      sourceVersion,
      createdBy: this.#actor,
      createdAt: occurredAt,
      sequence,
    };
    const previewTarget = this.#previewTarget(artifact, occurredAt);
    const outcome: WorkMutationSuccessOutcome = {
      kind: "revised",
      artifact,
      version,
      previewTarget,
    };
    const reply = this.#commitSuccess(
      request,
      entry.artifactId,
      entry.sequence,
      sequence,
      occurredAt,
      outcome,
      baseWorkCapabilityReport(targetFormat),
    );
    if (reply.outcome.kind !== "revised") return reply;

    // For a cross-format transform, remove the old source file now that the
    // new file and journal entry are committed. This is best-effort cleanup;
    // if the delete fails, the projection still points at the new path and
    // the orphaned old file is harmless.
    if (isCrossFormat && newResolutionForTransform !== undefined) {
      try {
        await this.#filesystem.unlink(resolved.absolutePath);
      } catch {
        // Best-effort cleanup; the new file and journal are committed.
      }
    }
    void newResolutionForTransform;
    return reply;
  }

  async #renameArtifact(
    request: Extract<WorkMutationRequest, { kind: "rename-artifact" }>,
    context: WorkMutationContext,
  ): Promise<WorkMutationReply> {
    const entry = this.#projection.lookup(request.artifactId);
    if (entry === undefined || entry.deleted) {
      return unauthorizedReply(request, "unknown-artifact");
    }
    if (entry.sequence !== request.expectedArtifactVersion) {
      return staleReply(request, entry.currentSourceVersion);
    }
    const capability = baseWorkCapabilityReport(entry.format);
    const budgetRejection = validateWorkDisplayNameBudget(request.displayName);
    if (budgetRejection !== undefined) return failedReply(request, "oversize");
    if (context.signal?.aborted) return interruptedReply(request);

    const resolution = await this.#resolution.resolve({
      binding: context.binding,
      relativePath: entry.relativePath,
      knownVersion: entry.currentSourceVersion,
    });
    const resolutionFailure = mapResolutionFailure(request, resolution);
    if (resolutionFailure !== undefined) return resolutionFailure;
    if (context.signal?.aborted) return interruptedReply(request);
    const resolved = resolution as Extract<typeof resolution, { status: "resolved" }>;

    let newRelativePath: string;
    try {
      newRelativePath = canonicalizeWorkRelativePath(request.displayName);
    } catch {
      return unauthorizedReply(request, "escapes-root", request.artifactId);
    }
    const newResolution = await this.#resolution.resolveForCreate({
      binding: context.binding,
      relativePath: newRelativePath,
    });
    if (newResolution.status !== "resolved-for-create") {
      return unauthorizedReply(request, newResolution.status, request.artifactId);
    }

    const authority = classifyMutationAuthority({
      posture: context.posture,
      mutationKind: "rename",
      capability,
      change: classifyDestructiveChange({ kind: "rename" }),
      rootRevocation: detectRevokedRoot({
        availability: context.binding.availability,
        bindingSuperseded: context.binding.bindingSuperseded,
      }),
      pathContainment: "contained",
      rootMoved: detectMovedRoot(
        { canonicalRoot: context.binding.canonicalRoot },
        { canonicalRoot: context.binding.knownCanonicalRoot },
      ),
      sourceAvailability: "available",
    });
    if (authority === "deny")
      return unauthorizedReply(request, "authority-denied", request.artifactId);
    if (authority === "needs-approval" && !context.approved) {
      return unauthorizedReply(request, "approval-required", request.artifactId);
    }

    try {
      await this.#filesystem.rename(resolved.absolutePath, newResolution.absolutePath);
    } catch {
      return failedReply(request, "write-failed", request.artifactId);
    }
    if (context.signal?.aborted) return interruptedReply(request);

    const sequence = entry.sequence + 1;
    const occurredAt = decodeTimestamp(this.#clock());
    // A rename carries the object, so the identity this mutation resolved still
    // describes it under its new name — and refuses anything else that arrived
    // there while the rename was authorized and performed.
    const bytes = await this.#readResolved(newResolution.absolutePath, resolved.sourceIdentity);
    if (bytes === undefined) return failedReply(request, "read-failed", request.artifactId);
    const sourceVersion = computeSourceVersion(bytes, occurredAt);
    const versionId = decodeWorkArtifactVersionId(this.#uuid());
    const artifact: WorkArtifactIdentity = {
      artifactId: entry.artifactId,
      projectId: entry.projectId,
      format: entry.format,
      artifactRef: decodeWorkArtifactRef(entry.artifactRef),
      displayName: decodeDisplayName(request.displayName),
      createdAt: decodeTimestamp(entry.currentSourceVersion.observedAt),
    };
    const version: WorkArtifactVersion = {
      versionId,
      artifactId: entry.artifactId,
      projectId: entry.projectId,
      format: entry.format,
      sourceVersion,
      createdBy: this.#actor,
      createdAt: occurredAt,
      sequence,
    };
    const previewTarget = this.#previewTarget(artifact, occurredAt);
    const outcome: WorkMutationSuccessOutcome = {
      kind: "revised",
      artifact,
      version,
      previewTarget,
    };
    return this.#commitSuccess(
      request,
      entry.artifactId,
      entry.sequence,
      sequence,
      occurredAt,
      outcome,
      capability,
    );
  }

  async #deleteArtifact(
    request: Extract<WorkMutationRequest, { kind: "delete-artifact" }>,
    context: WorkMutationContext,
  ): Promise<WorkMutationReply> {
    const entry = this.#projection.lookup(request.artifactId);
    if (entry === undefined || entry.deleted) {
      return unauthorizedReply(request, "unknown-artifact");
    }
    if (entry.sequence !== request.expectedArtifactVersion) {
      return staleReply(request, entry.currentSourceVersion);
    }
    const capability = baseWorkCapabilityReport(entry.format);
    if (context.signal?.aborted) return interruptedReply(request);

    const resolution = await this.#resolution.resolve({
      binding: context.binding,
      relativePath: entry.relativePath,
      knownVersion: entry.currentSourceVersion,
    });
    const resolutionFailure = mapResolutionFailure(request, resolution);
    if (resolutionFailure !== undefined) return resolutionFailure;
    if (context.signal?.aborted) return interruptedReply(request);
    const resolved = resolution as Extract<typeof resolution, { status: "resolved" }>;

    const authority = classifyMutationAuthority({
      posture: context.posture,
      mutationKind: "delete",
      capability,
      change: classifyDestructiveChange({ kind: "delete" }),
      rootRevocation: detectRevokedRoot({
        availability: context.binding.availability,
        bindingSuperseded: context.binding.bindingSuperseded,
      }),
      pathContainment: "contained",
      rootMoved: detectMovedRoot(
        { canonicalRoot: context.binding.canonicalRoot },
        { canonicalRoot: context.binding.knownCanonicalRoot },
      ),
      sourceAvailability: "available",
    });
    if (authority === "deny")
      return unauthorizedReply(request, "authority-denied", request.artifactId);
    if (authority === "needs-approval" && !context.approved) {
      return unauthorizedReply(request, "approval-required", request.artifactId);
    }

    try {
      await this.#filesystem.unlink(resolved.absolutePath);
    } catch {
      return failedReply(request, "write-failed", request.artifactId);
    }
    if (context.signal?.aborted) return interruptedReply(request);

    const sequence = entry.sequence + 1;
    const occurredAt = decodeTimestamp(this.#clock());
    const lastVersion: WorkArtifactVersion = {
      versionId: decodeWorkArtifactVersionId(this.#uuid()),
      artifactId: entry.artifactId,
      projectId: entry.projectId,
      format: entry.format,
      sourceVersion: entry.currentSourceVersion,
      createdBy: this.#actor,
      createdAt: occurredAt,
      sequence,
    };
    const outcome: WorkMutationSuccessOutcome = {
      kind: "deleted",
      artifactId: entry.artifactId,
      projectId: entry.projectId,
      lastVersion,
    };
    return this.#commitSuccess(
      request,
      entry.artifactId,
      entry.sequence,
      sequence,
      occurredAt,
      outcome,
      capability,
    );
  }

  async #versionArtifact(
    request: Extract<WorkMutationRequest, { kind: "version-artifact" }>,
    context: WorkMutationContext,
  ): Promise<WorkMutationReply> {
    const entry = this.#projection.lookup(request.artifactId);
    if (entry === undefined || entry.deleted) {
      return unauthorizedReply(request, "unknown-artifact");
    }
    if (entry.sequence !== request.expectedArtifactVersion) {
      return staleReply(request, entry.currentSourceVersion);
    }
    const capability = baseWorkCapabilityReport(entry.format);
    if (context.signal?.aborted) return interruptedReply(request);

    const resolution = await this.#resolution.resolve({
      binding: context.binding,
      relativePath: entry.relativePath,
      knownVersion: entry.currentSourceVersion,
    });
    const resolutionFailure = mapResolutionFailure(request, resolution);
    if (resolutionFailure !== undefined) return resolutionFailure;
    if (context.signal?.aborted) return interruptedReply(request);
    const resolved = resolution as Extract<typeof resolution, { status: "resolved" }>;

    const authority = classifyMutationAuthority({
      posture: context.posture,
      mutationKind: "version",
      capability,
      change: classifyDestructiveChange({ kind: "version" }),
      rootRevocation: detectRevokedRoot({
        availability: context.binding.availability,
        bindingSuperseded: context.binding.bindingSuperseded,
      }),
      pathContainment: "contained",
      rootMoved: detectMovedRoot(
        { canonicalRoot: context.binding.canonicalRoot },
        { canonicalRoot: context.binding.knownCanonicalRoot },
      ),
      sourceAvailability: "available",
    });
    if (authority === "deny")
      return unauthorizedReply(request, "authority-denied", request.artifactId);
    if (authority === "needs-approval" && !context.approved) {
      return unauthorizedReply(request, "approval-required", request.artifactId);
    }

    const bytes = await this.#readResolved(resolved.absolutePath, resolved.sourceIdentity);
    if (bytes === undefined) return failedReply(request, "read-failed", request.artifactId);
    if (context.signal?.aborted) return interruptedReply(request);

    const sequence = entry.sequence + 1;
    const occurredAt = decodeTimestamp(this.#clock());
    const sourceVersion = computeSourceVersion(bytes, occurredAt);
    const versionId = decodeWorkArtifactVersionId(this.#uuid());
    const artifact: WorkArtifactIdentity = {
      artifactId: entry.artifactId,
      projectId: entry.projectId,
      format: entry.format,
      artifactRef: decodeWorkArtifactRef(entry.artifactRef),
      displayName: decodeDisplayName(entry.displayName),
      createdAt: decodeTimestamp(entry.currentSourceVersion.observedAt),
    };
    const version: WorkArtifactVersion = {
      versionId,
      artifactId: entry.artifactId,
      projectId: entry.projectId,
      format: entry.format,
      sourceVersion,
      createdBy: this.#actor,
      createdAt: occurredAt,
      sequence,
    };
    const previewTarget = this.#previewTarget(artifact, occurredAt);
    const outcome: WorkMutationSuccessOutcome = {
      kind: "revised",
      artifact,
      version,
      previewTarget,
    };
    return this.#commitSuccess(
      request,
      entry.artifactId,
      entry.sequence,
      sequence,
      occurredAt,
      outcome,
      capability,
    );
  }

  async #exportArtifact(
    request: Extract<WorkMutationRequest, { kind: "export-artifact" }>,
    context: WorkMutationContext,
  ): Promise<WorkMutationReply> {
    const entry = this.#projection.lookup(request.artifactId);
    if (entry === undefined || entry.deleted) {
      return unauthorizedReply(request, "unknown-artifact");
    }
    if (entry.sequence !== request.expectedArtifactVersion) {
      return staleReply(request, entry.currentSourceVersion);
    }
    const sourceAdapter = getWorkFormatAdapter(entry.format);
    if (sourceAdapter === undefined) {
      return unsupportedReply(request, entry.format, request.artifactId);
    }
    const capability = baseWorkCapabilityReport(entry.format);
    if (context.signal?.aborted) return interruptedReply(request);

    const resolution = await this.#resolution.resolve({
      binding: context.binding,
      relativePath: entry.relativePath,
      knownVersion: entry.currentSourceVersion,
    });
    const resolutionFailure = mapResolutionFailure(request, resolution);
    if (resolutionFailure !== undefined) return resolutionFailure;
    if (context.signal?.aborted) return interruptedReply(request);
    const resolved = resolution as Extract<typeof resolution, { status: "resolved" }>;

    const authority = classifyMutationAuthority({
      posture: context.posture,
      mutationKind: "export",
      capability,
      change: classifyDestructiveChange({ kind: "export" }),
      rootRevocation: detectRevokedRoot({
        availability: context.binding.availability,
        bindingSuperseded: context.binding.bindingSuperseded,
      }),
      pathContainment: "contained",
      rootMoved: detectMovedRoot(
        { canonicalRoot: context.binding.canonicalRoot },
        { canonicalRoot: context.binding.knownCanonicalRoot },
      ),
      sourceAvailability: "available",
      exportFormat: request.exportFormat,
    });
    if (authority === "deny")
      return unsupportedReply(request, request.exportFormat, request.artifactId);
    if (authority === "needs-approval" && !context.approved) {
      return unauthorizedReply(request, "approval-required", request.artifactId);
    }

    const sourceBytes = await this.#readResolved(resolved.absolutePath, resolved.sourceIdentity);
    if (sourceBytes === undefined) return failedReply(request, "read-failed", request.artifactId);
    if (context.signal?.aborted) return interruptedReply(request);

    let exportBytes: Uint8Array | undefined;
    try {
      exportBytes = sourceAdapter.convertTo(request.exportFormat, sourceBytes);
    } catch (error) {
      if (error instanceof WorkAdapterBudgetError)
        return failedReply(request, "oversize", request.artifactId);
      return failedReply(request, "parse-failed", request.artifactId);
    }
    if (exportBytes === undefined) {
      return unsupportedReply(request, request.exportFormat, request.artifactId);
    }
    const outputRejection = validateWorkOutputBudget(exportBytes.byteLength);
    if (outputRejection !== undefined) return failedReply(request, "oversize", request.artifactId);
    if (context.signal?.aborted) return interruptedReply(request);

    const occurredAt = decodeTimestamp(this.#clock());
    const exportFormat = request.exportFormat;

    const exportDisplayName = displayNameForTargetFormat(
      decodeDisplayName(entry.displayName),
      exportFormat,
    );
    const exportRelativePath = canonicalizeWorkRelativePath(exportDisplayName);
    const exportResolution = await this.#resolution.resolveForCreate({
      binding: context.binding,
      relativePath: exportRelativePath,
    });
    if (exportResolution.status !== "resolved-for-create") {
      return unauthorizedReply(request, exportResolution.status, request.artifactId);
    }

    const samePath = exportResolution.absolutePath === resolved.absolutePath;
    let exportBytesAlreadyWritten = samePath && bytesEqual(sourceBytes, exportBytes);
    if (!samePath) {
      let targetPresent = true;
      try {
        await this.#filesystem.lstat(exportResolution.absolutePath);
      } catch {
        targetPresent = false;
      }
      if (targetPresent) {
        // Something already answers to the export name, so it has to be read as
        // a contained regular file or refused. A file this export cannot read is
        // not one it may overwrite either.
        const existingBytes = await this.#readExistingTarget(exportResolution.absolutePath);
        if (existingBytes === undefined || !bytesEqual(existingBytes, exportBytes)) {
          return failedReply(request, "write-failed", request.artifactId);
        }
        exportBytesAlreadyWritten = true;
      }
    }
    if (!exportBytesAlreadyWritten) {
      try {
        await this.#filesystem.writeFile(exportResolution.absolutePath, exportBytes);
      } catch {
        return failedReply(request, "write-failed", request.artifactId);
      }
    }
    if (context.signal?.aborted) return interruptedReply(request);

    // The derived bytes are materialized before the journal frame. The
    // produced version and preview target therefore describe real confined
    // bytes rather than relabeling the source file with another format.
    const sequence = entry.sequence + 1;
    const sourceVersion = computeSourceVersion(exportBytes, occurredAt);
    const versionId = decodeWorkArtifactVersionId(this.#uuid());
    const producedVersion: WorkArtifactVersion = {
      versionId,
      artifactId: entry.artifactId,
      projectId: entry.projectId,
      format: exportFormat,
      sourceVersion,
      createdBy: this.#actor,
      createdAt: occurredAt,
      sequence,
    };
    const previewTarget = this.#previewTarget(
      {
        artifactId: entry.artifactId,
        projectId: entry.projectId,
        format: exportFormat,
        artifactRef: decodeWorkArtifactRef(entry.artifactRef),
        displayName: exportDisplayName,
        createdAt: decodeTimestamp(entry.currentSourceVersion.observedAt),
      },
      occurredAt,
    );
    // Formats whose adapters declare external-application handoff (docx,
    // pdf, image) hand the exported file to the native host instead of
    // producing an in-app preview version: the export carries an opaque ref
    // the authenticated desktop bridge resolves to the confined export path
    // for Finder reveal / Quick Look / open-external. The export overwrites
    // the same confined relative path for these same-format exports, so the
    // artifact ref still resolves to the exported bytes and the projection
    // keeps the source artifact authoritative (no parallel path is minted).
    const handoff: WorkExportHandoff = EXTERNAL_HANDOFF_EXPORT_FORMATS.has(exportFormat)
      ? {
          requestId: request.requestId,
          artifactId: entry.artifactId,
          exportFormat,
          handoffKind: "external-handoff",
          exportRef: entry.artifactRef,
          producedAt: occurredAt,
        }
      : {
          requestId: request.requestId,
          artifactId: entry.artifactId,
          exportFormat,
          handoffKind: "in-app-version",
          producedVersion,
          previewTarget,
          producedAt: occurredAt,
        };
    const outcome: WorkMutationSuccessOutcome = { kind: "exported", handoff };
    return this.#commitSuccess(
      request,
      entry.artifactId,
      entry.sequence,
      sequence,
      occurredAt,
      outcome,
      baseWorkCapabilityReport(exportFormat),
    );
  }

  #commitSuccess(
    request: WorkMutationRequest,
    artifactId: WorkArtifactId,
    expectedSequence: number,
    sequence: number,
    occurredAt: typeof UtcTimestamp.Type,
    outcome: WorkMutationSuccessOutcome,
    capability: WorkCapabilityReport,
  ): WorkMutationReply {
    const frame = this.#buildFrame(request, request.projectId, sequence, occurredAt, outcome);
    try {
      this.#eventStore.append({ artifactId, expectedSequence, frame });
    } catch {
      return failedReply(request, "write-failed", artifactId);
    }
    this.#projection.apply(frame);
    return successReply(request, outcome, capability);
  }

  #buildFrame(
    request: WorkMutationRequest,
    projectId: ProjectId,
    sequence: number,
    occurredAt: typeof UtcTimestamp.Type,
    outcome: WorkMutationSuccessOutcome,
  ): WorkArtifactMutationFrame {
    return {
      requestId: request.requestId,
      projectId,
      sequence,
      occurredAt,
      outcome,
    };
  }

  #previewTarget(
    artifact: WorkArtifactIdentity,
    _occurredAt: typeof UtcTimestamp.Type,
  ): typeof PreviewTarget.Type {
    return decodePreviewTarget({
      targetId: this.#uuid(),
      projectId: artifact.projectId,
      hostId: this.#hostId,
      kind: "artifact-version",
      opaqueRef: artifact.artifactRef,
      displayName: artifact.displayName,
    });
  }
}

function computeSourceVersion(
  bytes: Uint8Array,
  observedAt: typeof UtcTimestamp.Type,
): PreviewSourceVersion {
  return {
    contentSha256: decodeSha256(createHash("sha256").update(bytes).digest("hex")),
    byteSize: bytes.byteLength,
    observedAt,
  };
}

function mapResolutionFailure(
  request: WorkMutationRequest,
  resolution: Awaited<ReturnType<WorkResolutionService["resolve"]>>,
): WorkMutationReply | undefined {
  const artifactId = (request as { artifactId?: WorkArtifactId }).artifactId;
  switch (resolution.status) {
    case "revoked-root":
    case "moved-root":
    case "escapes-root":
    case "symlink-escape":
      return unauthorizedReply(request, resolution.status, artifactId);
    case "unavailable":
      return failedReply(request, "read-failed", artifactId);
    case "stale":
      return staleReply(request, resolution.knownVersion, artifactId);
    default:
      return undefined;
  }
}

function successReply(
  request: WorkMutationRequest,
  outcome: WorkMutationSuccessOutcome,
  capability: WorkCapabilityReport,
): WorkMutationReply {
  return decodeReply({
    requestId: request.requestId,
    outcome,
    capability,
  });
}

function unsupportedReply(
  request: WorkMutationRequest,
  format: WorkArtifactFormat,
  artifactId?: WorkArtifactId,
): WorkMutationReply {
  const outcome: WorkMutationOutcome = {
    kind: "unsupported",
    format,
    canOpenExternally: true,
  };
  if (artifactId !== undefined)
    (outcome as { artifactId?: WorkArtifactId }).artifactId = artifactId;
  return decodeReply({ requestId: request.requestId, outcome });
}

function unauthorizedReply(
  request: WorkMutationRequest,
  _reason: UnauthorizedReason | string,
  artifactId?: WorkArtifactId,
): WorkMutationReply {
  const outcome: WorkMutationOutcome = { kind: "unauthorized" };
  if (artifactId !== undefined)
    (outcome as { artifactId?: WorkArtifactId }).artifactId = artifactId;
  return decodeReply({ requestId: request.requestId, outcome });
}

function staleReply(
  request: WorkMutationRequest,
  knownVersion: PreviewSourceVersion,
  artifactId?: WorkArtifactId,
): WorkMutationReply {
  const outcome: WorkMutationOutcome = {
    kind: "stale",
    artifactId:
      artifactId ??
      (request as { artifactId?: WorkArtifactId }).artifactId ??
      decodeWorkArtifactId("00000000-0000-4000-8000-000000000000"),
    knownVersion,
  };
  return decodeReply({ requestId: request.requestId, outcome });
}

function failedReply(
  request: WorkMutationRequest,
  reason:
    | "decode-failed"
    | "read-failed"
    | "write-failed"
    | "parse-failed"
    | "oversize"
    | "cancelled"
    | "unknown",
  artifactId?: WorkArtifactId,
): WorkMutationReply {
  const outcome: WorkMutationOutcome = { kind: "failed", reason };
  if (artifactId !== undefined)
    (outcome as { artifactId?: WorkArtifactId }).artifactId = artifactId;
  return decodeReply({ requestId: request.requestId, outcome });
}

function interruptedReply(request: WorkMutationRequest): WorkMutationReply {
  const artifactId = (request as { artifactId?: WorkArtifactId }).artifactId;
  const outcome: WorkMutationOutcome = { kind: "interrupted", canRetry: true };
  if (artifactId !== undefined)
    (outcome as { artifactId?: WorkArtifactId }).artifactId = artifactId;
  return decodeReply({ requestId: request.requestId, outcome });
}

/**
 * File extension for a Work artifact format. Used by the transform path to
 * compute a target-format display name so a cross-format transform (e.g.
 * DOCX→markdown) materializes under a target-format filename instead of
 * leaving markdown bytes under a `.docx` name.
 */
function extensionForFormat(format: WorkArtifactFormat): string {
  switch (format) {
    case "markdown":
      return ".md";
    case "csv":
      return ".csv";
    case "markdown-deck":
      return ".md";
    case "docx":
      return ".docx";
    case "xlsx":
      return ".xlsx";
    case "pptx":
      return ".pptx";
    case "pdf":
      return ".pdf";
    case "image":
      return ".png";
  }
}

/**
 * Replace the file extension of a display name with the extension for the
 * target format. If the current display name has no recognizable extension,
 * append the target extension. This keeps the base name stable while ensuring
 * the extension matches the target format.
 */
function displayNameForTargetFormat(
  currentDisplayName: string,
  targetFormat: WorkArtifactFormat,
): string {
  const targetExt = extensionForFormat(targetFormat);
  const lastDot = currentDisplayName.lastIndexOf(".");
  if (lastDot > 0) {
    return `${currentDisplayName.slice(0, lastDot)}${targetExt}`;
  }
  return `${currentDisplayName}${targetExt}`;
}

/** Constant-time byte comparison for retry-orphan detection. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
