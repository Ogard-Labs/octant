import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { Schema } from "effect";
import type { OctantMode } from "@octant/contracts/modes";
import type { CodeThreadId } from "@octant/contracts/code";
import type { ProjectId, ProjectType } from "@octant/contracts/projects";
import {
  PreviewChunkSequence,
  decodePreviewCancelReply,
  decodePreviewChunksReply,
  decodePreviewChunkId,
  decodePreviewManifest,
  decodePreviewOutcome,
  type PreviewChunk,
  type PreviewChunkId,
  type PreviewFailureCode,
  type PreviewHandoffKind,
  type PreviewHostId,
  type PreviewKind,
  type PreviewManifest,
  type PreviewOutcome,
  type PreviewCancelReply,
  type PreviewChunksReply,
  type PreviewSourceVersion,
  type PreviewTarget,
  type PreviewTargetId,
  type PreviewTargetKind,
} from "@octant/contracts/previews";
import {
  authorizePreviewHandoff,
  authorizePreviewTarget,
  resolvePreviewCapabilities,
  type PreviewPosture,
} from "@octant/domain";
import { producePreviewManifest, type PreviewBudget } from "./previewManifest";
import { sniffPreviewKind } from "./previewSniffer";
import { resolveConfinedPath } from "./previewTargetRegistry";
import { produceTextChunksFromBytes } from "./previewTextChunker";
import { produceImageChunkFromBytes } from "./previewImageChunker";
import { DEFAULT_PDF_BUDGET, parsePdf, producePdfChunks } from "./previewPdfChunker";
import {
  DEFAULT_TABLE_BUDGET,
  inferTableDelimiter,
  produceTableChunks,
} from "./previewTableChunker";
import {
  DEFAULT_WORKBOOK_BUDGET,
  parseWorkbook,
  produceWorkbookChunks,
} from "./previewWorkbookChunker";
import {
  DEFAULT_DOCUMENT_BUDGET,
  parseDocument,
  produceDocumentChunks,
} from "./previewDocumentChunker";
import { DEFAULT_SLIDES_BUDGET, parseSlides, produceSlidesChunks } from "./previewSlidesChunker";
import {
  computePreviewSourceVersionFromBytes,
  samePreviewSourceVersion,
} from "./previewSourceVersion";

const decodeSequence = Schema.decodeUnknownSync(PreviewChunkSequence);
type PreviewChunkGenerator = Generator<PreviewChunk> | "parse-failed" | undefined;

function safeParse<T>(parse: () => T | undefined): T | "parse-failed" {
  try {
    return parse() ?? "parse-failed";
  } catch {
    return "parse-failed";
  }
}

/**
 * Authority posture of the active thread, resolved by the route from the
 * authenticated window and the target's Project. Plan mode is always
 * read-only, including when Full access is remembered for a Code Project.
 */
export interface PreviewAuthorityContext {
  readonly mode: OctantMode;
  readonly projectType: ProjectType;
  readonly activeProjectId: ProjectId;
  readonly activeHostId: PreviewHostId;
  readonly activeThreadId?: CodeThreadId;
  readonly posture: PreviewPosture;
}

/**
 * Server-side resolution of an authenticated external-application preview
 * handoff. `resolved` carries the confined absolute path for the native
 * desktop executor only; the renderer-facing route maps it to a path-free
 * `done` reply so no host path crosses the renderer boundary. Failure kinds
 * mirror the contract reply and never carry a path.
 */
export type PreviewHandoffResolution =
  | {
      readonly kind: "resolved";
      readonly absolutePath: string;
      readonly handoffKind: PreviewHandoffKind;
      readonly displayName: string;
    }
  | { readonly kind: "unauthorized"; readonly targetId: PreviewTargetId }
  | { readonly kind: "unavailable"; readonly target: PreviewTarget }
  | {
      readonly kind: "failed";
      readonly reason: PreviewFailureCode;
      readonly message?: string;
    };

/**
 * Principal kind of the authenticated transport. Remote least-authority
 * principals can never command host-native handoff side effects.
 */
export type PreviewHandoffPrincipalKind = "local-window" | "remote-device";

/**
 * Server-side resolution of an opaque preview target to a confined relative
 * path and display name inside the Project root. The renderer never sees the
 * relative path; the resolver is the authoritative mapping from the
 * path-free `opaqueRef` to a host filesystem location. A `not-found` result
 * is indistinguishable from an authority denial at the outcome layer so a
 * revoked window cannot probe target existence.
 */
export interface PreviewTargetResolver {
  resolve(input: {
    readonly projectId: ProjectId;
    readonly opaqueRef: string;
    readonly kind: PreviewTargetKind;
  }): Promise<
    | { readonly ok: true; readonly relativePath: string; readonly displayName: string }
    | { readonly ok: false; readonly code: "not-found" }
  >;
}

/**
 * Server-side resolution of a Project id to its canonical confined root. A
 * Work or Code Project's root is the binding's canonical absolute path; the
 * preview service re-resolves it on every request so a moved or revoked root
 * surfaces as `unavailable` rather than reading from a stale location.
 */
export interface PreviewProjectRootResolver {
  resolve(
    projectId: ProjectId,
  ): Promise<
    | { readonly ok: true; readonly canonicalRoot: string }
    | { readonly ok: false; readonly code: "unavailable" }
  >;
}

export interface PreviewServiceOptions {
  readonly targetResolver: PreviewTargetResolver;
  readonly projectRootResolver: PreviewProjectRootResolver;
  readonly hostId: PreviewHostId;
  readonly budget: PreviewBudget;
  readonly textBudget: {
    readonly maxLinesPerChunk: number;
    readonly maxBytesPerChunk: number;
    readonly maxRenderBytes?: number;
  };
  readonly uuid?: () => string;
}

/**
 * Server-authoritative preview service. Re-authorizes every open/chunk/
 * refresh/cancel request against the active host, mode, Project, source
 * version, and current credential authority before any host read; resolves
 * opaque refs to confined paths through the registry; and surfaces every
 * failure as a distinct typed outcome. Unauthorized outcomes disclose only
 * the opaque target id — never content-derived metadata, display name, media
 * type, or raw path. Cancellation aborts in-flight stream state and surfaces
 * `interrupted` for the aborted read.
 */
export class PreviewService {
  readonly #targetResolver: PreviewTargetResolver;
  readonly #projectRootResolver: PreviewProjectRootResolver;
  readonly #hostId: PreviewHostId;
  readonly #budget: PreviewBudget;
  readonly #textBudget: PreviewServiceOptions["textBudget"];
  readonly #uuid: () => string;
  readonly #inFlight = new Map<PreviewTargetId, AbortController>();

  constructor(options: PreviewServiceOptions) {
    this.#targetResolver = options.targetResolver;
    this.#projectRootResolver = options.projectRootResolver;
    this.#hostId = options.hostId;
    this.#budget = options.budget;
    this.#textBudget = options.textBudget;
    this.#uuid = options.uuid ?? randomUUID;
  }

  async open(input: {
    readonly authority: PreviewAuthorityContext;
    readonly target: PreviewTarget;
    readonly knownVersion?: PreviewSourceVersion;
  }): Promise<PreviewOutcome> {
    if (authorizePreviewTarget(this.#authorityInput(input.authority, input.target)) === "deny") {
      return this.#unauthorized(input.target.targetId);
    }
    const resolution = await this.#resolveTarget(input.target);
    if (!resolution.ok) return this.#unauthorized(input.target.targetId);

    const root = await this.#projectRootResolver.resolve(input.target.projectId);
    if (!root.ok) return this.#unavailable(input.target);

    const manifest = producePreviewManifest({
      projectRoot: root.canonicalRoot,
      hostId: this.#hostId,
      projectId: input.target.projectId,
      record: {
        targetId: input.target.targetId,
        kind: input.target.kind,
        opaqueRef: input.target.opaqueRef,
        relativePath: resolution.relativePath,
      },
      budget: this.#budget,
    });
    if (!manifest.ok) {
      if (manifest.code === "containment-violation") {
        return this.#unauthorized(input.target.targetId);
      }
      if (manifest.code === "too-large") {
        return decodePreviewOutcome({
          kind: "too-large",
          target: input.target,
          byteSize: manifest.byteSize,
          limit: manifest.limit,
          canOpenExternally: true,
        });
      }
      return this.#unavailable(input.target);
    }

    const current = this.#withEffectiveCapabilities(manifest.manifest, input.authority);
    if (input.knownVersion !== undefined) {
      if (!samePreviewSourceVersion(current.sourceVersion, input.knownVersion)) {
        return decodePreviewOutcome({
          kind: "stale",
          target: input.target,
          knownVersion: input.knownVersion,
        });
      }
    }

    if (
      current.kind === "unsupported" ||
      !(STREAMABLE_PREVIEW_KINDS as ReadonlyArray<string>).includes(current.kind)
    ) {
      return decodePreviewOutcome({
        kind: "unsupported",
        target: input.target,
        mediaType: current.sniffedMediaType,
        canOpenExternally: current.capabilities.canOpenExternally,
      });
    }
    if (current.fidelity.level === "limited") {
      return decodePreviewOutcome({ kind: "limited-fidelity", manifest: current });
    }
    return decodePreviewOutcome({ kind: "ready", manifest: current });
  }

  async refresh(input: {
    readonly authority: PreviewAuthorityContext;
    readonly target: PreviewTarget;
    readonly knownVersion: PreviewSourceVersion;
  }): Promise<PreviewOutcome> {
    return this.open(input);
  }

  async readChunks(input: {
    readonly authority: PreviewAuthorityContext;
    readonly target: PreviewTarget;
    readonly sourceVersion: PreviewSourceVersion;
    readonly afterSequence: number;
    readonly maxChunks?: number;
    readonly signal?: AbortSignal;
  }): Promise<PreviewChunksReply> {
    if (authorizePreviewTarget(this.#authorityInput(input.authority, input.target)) === "deny") {
      return this.#unauthorizedChunks(input.target.targetId);
    }
    const resolution = await this.#resolveTarget(input.target);
    if (!resolution.ok) return this.#unauthorizedChunks(input.target.targetId);

    const root = await this.#projectRootResolver.resolve(input.target.projectId);
    if (!root.ok) return this.#unavailableChunks(input.target);

    const confined = resolveConfinedPath(root.canonicalRoot, resolution.relativePath);
    if (!confined.ok) {
      if (confined.code === "containment-violation") {
        return this.#unauthorizedChunks(input.target.targetId);
      }
      return this.#unavailableChunks(input.target);
    }

    const controller = this.#registerInFlight(input.target.targetId, input.signal);
    try {
      return await this.#produceChunks({
        target: input.target,
        sourceVersion: input.sourceVersion,
        afterSequence: input.afterSequence,
        ...(input.maxChunks === undefined ? {} : { maxChunks: input.maxChunks }),
        absolutePath: confined.absolutePath,
        displayName: resolution.displayName,
        controller,
      });
    } finally {
      this.#unregisterInFlight(input.target.targetId, controller);
    }
  }

  async cancel(input: {
    readonly authority: PreviewAuthorityContext;
    readonly target: PreviewTarget;
  }): Promise<PreviewCancelReply> {
    if (authorizePreviewTarget(this.#authorityInput(input.authority, input.target)) === "deny") {
      return decodePreviewCancelReply({ kind: "unauthorized", targetId: input.target.targetId });
    }
    const controller = this.#inFlight.get(input.target.targetId);
    if (controller === undefined) {
      return decodePreviewCancelReply({ kind: "not-found" });
    }
    controller.abort();
    this.#inFlight.delete(input.target.targetId);
    return decodePreviewCancelReply({ kind: "cancelled" });
  }

  /**
   * Resolve an authenticated external-application preview handoff to the
   * confined absolute export path. Re-runs the preview target authority plus
   * the handoff-specific fail-closed policy (plan mode and remote
   * least-authority principals always deny) before any host resolution, then
   * re-checks the effective visible capability for the requested kind so a
   * capability hidden by the active posture can never be commanded. The
   * returned resolution never embeds a path in a failure branch; only
   * `resolved` carries the absolute path, and only the desktop bridge route
   * forwards it to the trusted native executor.
   */
  async handoff(input: {
    readonly authority: PreviewAuthorityContext;
    readonly principalKind: PreviewHandoffPrincipalKind;
    readonly target: PreviewTarget;
    readonly kind: PreviewHandoffKind;
    readonly signal?: AbortSignal;
  }): Promise<PreviewHandoffResolution> {
    if (
      authorizePreviewHandoff({
        ...this.#authorityInput(input.authority, input.target),
        posture: input.authority.posture,
        principalKind: input.principalKind,
      }) === "deny"
    ) {
      return this.#handoffUnauthorized(input.target.targetId);
    }
    const resolution = await this.#resolveTarget(input.target);
    if (!resolution.ok) return this.#handoffUnauthorized(input.target.targetId);

    const root = await this.#projectRootResolver.resolve(input.target.projectId);
    if (!root.ok) return this.#handoffUnavailable(input.target);

    const confined = resolveConfinedPath(root.canonicalRoot, resolution.relativePath);
    if (!confined.ok) {
      if (confined.code === "containment-violation") {
        return this.#handoffUnauthorized(input.target.targetId);
      }
      return this.#handoffUnavailable(input.target);
    }
    if (input.signal?.aborted) return this.#handoffFailed("cancelled");

    // Re-check the effective visible capability for the requested kind before
    // returning the path: a capability the active posture hides (for example
    // every handoff flag in plan mode) must fail closed even if a manifest
    // slipped through, and a format that never advertised the affordance can
    // not be commanded into it.
    const manifest = producePreviewManifest({
      projectRoot: root.canonicalRoot,
      hostId: this.#hostId,
      projectId: input.target.projectId,
      record: {
        targetId: input.target.targetId,
        kind: input.target.kind,
        opaqueRef: input.target.opaqueRef,
        relativePath: resolution.relativePath,
      },
      budget: this.#budget,
    });
    if (!manifest.ok) {
      if (manifest.code === "containment-violation") {
        return this.#handoffUnauthorized(input.target.targetId);
      }
      // A source that exceeds the preview budget is still a real confined
      // file and remains eligible for native handoff.
      if (manifest.code === "too-large") {
        return this.#handoffResolved(input, confined.absolutePath, resolution.displayName);
      }
      return this.#handoffUnavailable(input.target);
    }
    const effective = this.#withEffectiveCapabilities(manifest.manifest, input.authority);
    const capabilityForKind =
      input.kind === "reveal-in-finder"
        ? effective.capabilities.canRevealInFinder
        : input.kind === "quick-look"
          ? effective.capabilities.canQuickLook
          : effective.capabilities.canOpenExternally;
    if (!capabilityForKind) return this.#handoffUnauthorized(input.target.targetId);
    if (input.signal?.aborted) return this.#handoffFailed("cancelled");
    return this.#handoffResolved(input, confined.absolutePath, resolution.displayName);
  }

  #handoffResolved(
    input: { readonly kind: PreviewHandoffKind },
    absolutePath: string,
    displayName: string,
  ): PreviewHandoffResolution {
    return { kind: "resolved", absolutePath, handoffKind: input.kind, displayName };
  }

  #handoffUnauthorized(targetId: PreviewTargetId): PreviewHandoffResolution {
    return { kind: "unauthorized", targetId };
  }

  #handoffUnavailable(target: PreviewTarget): PreviewHandoffResolution {
    return { kind: "unavailable", target };
  }

  #handoffFailed(reason: PreviewFailureCode): PreviewHandoffResolution {
    return { kind: "failed", reason };
  }

  #authorityInput(authority: PreviewAuthorityContext, target: PreviewTarget) {
    return {
      mode: authority.mode,
      projectType: authority.projectType,
      activeProjectId: authority.activeProjectId,
      activeHostId: authority.activeHostId,
      ...(authority.activeThreadId === undefined
        ? {}
        : { activeThreadId: authority.activeThreadId }),
      target,
    };
  }

  async #resolveTarget(target: PreviewTarget) {
    return this.#targetResolver.resolve({
      projectId: target.projectId,
      opaqueRef: target.opaqueRef,
      kind: target.kind,
    });
  }

  #registerInFlight(targetId: PreviewTargetId, signal: AbortSignal | undefined): AbortController {
    const existing = this.#inFlight.get(targetId);
    if (existing !== undefined) existing.abort();
    const controller = new AbortController();
    this.#inFlight.set(targetId, controller);
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return controller;
  }

  #unregisterInFlight(targetId: PreviewTargetId, controller: AbortController): void {
    if (this.#inFlight.get(targetId) === controller) {
      this.#inFlight.delete(targetId);
    }
  }

  async #produceChunks(input: {
    readonly target: PreviewTarget;
    readonly sourceVersion: PreviewSourceVersion;
    readonly afterSequence: number;
    readonly maxChunks?: number;
    readonly absolutePath: string;
    readonly displayName: string;
    readonly controller: AbortController;
  }): Promise<PreviewChunksReply> {
    let size: number;
    try {
      size = statSync(input.absolutePath).size;
    } catch {
      return this.#unavailableChunks(input.target);
    }
    if (size > this.#budget.maxByteSize) {
      return decodePreviewChunksReply({
        kind: "failed",
        target: input.target,
        reason: "read-failed",
        message: "Preview source exceeds the read budget.",
      });
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(input.absolutePath);
    } catch {
      return this.#unavailableChunks(input.target);
    }

    const sniffed = sniffPreviewKind(bytes, input.displayName, "application/octet-stream", {
      maxSniffBytes: this.#budget.maxSniffBytes,
      maxByteSize: this.#budget.maxByteSize,
    });
    if (!sniffed.ok) {
      return decodePreviewChunksReply({
        kind: "failed",
        target: input.target,
        reason: "read-failed",
      });
    }
    const kind = sniffed.kind;
    // Unsupported kinds have no chunks to stream, so the stale guard does not
    // apply: surface `unsupported` before the version check so a caller never
    // receives a stale outcome for a format it cannot stream in the first place.
    if (!(STREAMABLE_PREVIEW_KINDS as ReadonlyArray<string>).includes(kind)) {
      return decodePreviewChunksReply({
        kind: "unsupported",
        target: input.target,
        mediaType: sniffed.mediaType,
        canOpenExternally: true,
      });
    }

    const currentVersion = computePreviewSourceVersionFromBytes(bytes);
    if (!samePreviewSourceVersion(currentVersion, input.sourceVersion)) {
      return decodePreviewChunksReply({
        kind: "stale",
        target: input.target,
        knownVersion: input.sourceVersion,
      });
    }

    if (input.controller.signal.aborted) {
      return decodePreviewChunksReply({
        kind: "interrupted",
        target: input.target,
        canRetry: true,
      });
    }

    const chunkId = decodePreviewChunkId(this.#uuid());
    const maxChunks = input.maxChunks;

    if (kind === "image") {
      if (input.afterSequence > 0) {
        return decodePreviewChunksReply({ kind: "chunks", chunks: [] });
      }
      const result = produceImageChunkFromBytes({
        bytes,
        targetId: input.target.targetId,
        chunkId,
        sourceVersion: input.sourceVersion,
        mediaType: sniffed.mediaType,
      });
      if (!result.ok) {
        if (result.code === "stale") {
          return decodePreviewChunksReply({
            kind: "stale",
            target: input.target,
            knownVersion: input.sourceVersion,
          });
        }
        return this.#unavailableChunks(input.target);
      }
      return decodePreviewChunksReply({ kind: "chunks", chunks: [result.chunk] });
    }

    const generator = this.#chunkGenerator({
      kind,
      bytes,
      absolutePath: input.absolutePath,
      targetId: input.target.targetId,
      chunkId,
      sourceVersion: input.sourceVersion,
      mediaType: sniffed.mediaType,
    });
    if (generator === "parse-failed") {
      return decodePreviewChunksReply({
        kind: "failed",
        target: input.target,
        reason: "parse-failed",
        message: "Preview source could not be decoded safely.",
      });
    }
    if (generator === undefined) {
      return decodePreviewChunksReply({
        kind: "unsupported",
        target: input.target,
        mediaType: sniffed.mediaType,
        canOpenExternally: true,
      });
    }

    const collected: PreviewChunk[] = [];
    for (const chunk of generator) {
      if (input.controller.signal.aborted) {
        return decodePreviewChunksReply({
          kind: "interrupted",
          target: input.target,
          canRetry: true,
        });
      }
      if (chunk.sequence < decodeSequence(input.afterSequence)) continue;
      collected.push(chunk);
      if (maxChunks !== undefined && collected.length >= maxChunks) break;
    }
    return decodePreviewChunksReply({ kind: "chunks", chunks: collected });
  }

  #chunkGenerator(input: {
    readonly kind: PreviewKind;
    readonly bytes: Buffer;
    readonly absolutePath: string;
    readonly targetId: PreviewTargetId;
    readonly chunkId: PreviewChunkId;
    readonly sourceVersion: PreviewSourceVersion;
    readonly mediaType: string;
  }): PreviewChunkGenerator {
    if (input.kind === "text" || input.kind === "markdown") {
      return produceTextChunksFromBytes({
        bytes: input.bytes,
        content: input.bytes.toString("utf-8"),
        targetId: input.targetId,
        chunkId: input.chunkId,
        sourceVersion: input.sourceVersion,
        kind: input.kind,
        budget: this.#textBudget,
      });
    }
    if (input.kind === "pdf") {
      const parsed = safeParse(() =>
        parsePdf(input.bytes, {
          maxPages: DEFAULT_PDF_BUDGET.maxPages,
          maxPageTextBytes: DEFAULT_PDF_BUDGET.maxPageTextBytes,
        }),
      );
      if (parsed === "parse-failed") return parsed;
      return producePdfChunks({
        filePath: input.absolutePath,
        targetId: input.targetId,
        chunkId: input.chunkId,
        sourceVersion: input.sourceVersion,
        budget: {
          ...DEFAULT_PDF_BUDGET,
          ...(this.#budget.maxRenderBytes === undefined
            ? {}
            : { maxRenderBytes: this.#budget.maxRenderBytes }),
        },
      });
    }
    if (input.kind === "table") {
      const delimiter =
        input.mediaType === "text/tab-separated-values"
          ? "\t"
          : input.mediaType === "text/csv"
            ? ","
            : (inferTableDelimiter(input.bytes.toString("utf-8")) ?? ",");
      return produceTableChunks({
        filePath: input.absolutePath,
        targetId: input.targetId,
        chunkId: input.chunkId,
        sourceVersion: input.sourceVersion,
        delimiter,
        budget: {
          ...DEFAULT_TABLE_BUDGET,
          ...(this.#budget.maxRenderBytes === undefined
            ? {}
            : { maxRenderBytes: this.#budget.maxRenderBytes }),
        },
      });
    }
    if (input.kind === "workbook") {
      const parsed = safeParse(() =>
        parseWorkbook(input.bytes, {
          maxRows: DEFAULT_WORKBOOK_BUDGET.maxRows,
          maxColumns: DEFAULT_WORKBOOK_BUDGET.maxColumns,
          maxWorksheets: DEFAULT_WORKBOOK_BUDGET.maxWorksheets,
        }),
      );
      if (parsed === "parse-failed") return parsed;
      return produceWorkbookChunks({
        filePath: input.absolutePath,
        targetId: input.targetId,
        chunkId: input.chunkId,
        sourceVersion: input.sourceVersion,
        budget: {
          ...DEFAULT_WORKBOOK_BUDGET,
          ...(this.#budget.maxRenderBytes === undefined
            ? {}
            : { maxRenderBytes: this.#budget.maxRenderBytes }),
        },
      });
    }
    if (input.kind === "document") {
      const parsed = safeParse(() =>
        parseDocument(input.bytes, {
          maxBlocks: DEFAULT_DOCUMENT_BUDGET.maxBlocks,
          maxBlockTextBytes: DEFAULT_DOCUMENT_BUDGET.maxBlockTextBytes,
        }),
      );
      if (parsed === "parse-failed") return parsed;
      return produceDocumentChunks({
        filePath: input.absolutePath,
        targetId: input.targetId,
        chunkId: input.chunkId,
        sourceVersion: input.sourceVersion,
        budget: {
          ...DEFAULT_DOCUMENT_BUDGET,
          ...(this.#budget.maxRenderBytes === undefined
            ? {}
            : { maxRenderBytes: this.#budget.maxRenderBytes }),
        },
      });
    }
    if (input.kind === "slides") {
      const parsed = safeParse(() =>
        parseSlides(input.bytes, {
          maxSlides: DEFAULT_SLIDES_BUDGET.maxSlides,
          maxSlideTextBytes: DEFAULT_SLIDES_BUDGET.maxSlideTextBytes,
        }),
      );
      if (parsed === "parse-failed") return parsed;
      return produceSlidesChunks({
        filePath: input.absolutePath,
        targetId: input.targetId,
        chunkId: input.chunkId,
        sourceVersion: input.sourceVersion,
        budget: {
          ...DEFAULT_SLIDES_BUDGET,
          ...(this.#budget.maxRenderBytes === undefined
            ? {}
            : { maxRenderBytes: this.#budget.maxRenderBytes }),
        },
      });
    }
    return undefined;
  }

  #unauthorized(targetId: PreviewTargetId): PreviewOutcome {
    return decodePreviewOutcome({ kind: "unauthorized", targetId });
  }

  #unavailable(target: PreviewTarget): PreviewOutcome {
    return decodePreviewOutcome({ kind: "unavailable", target });
  }

  #withEffectiveCapabilities(
    manifest: PreviewManifest,
    authority: PreviewAuthorityContext,
  ): PreviewManifest {
    const capabilities = resolvePreviewCapabilities({
      mode: authority.mode,
      posture: authority.posture,
      kind: manifest.kind,
      baseCapabilities: manifest.capabilities,
    });
    return decodePreviewManifest({ ...manifest, capabilities });
  }

  #unauthorizedChunks(targetId: PreviewTargetId): PreviewChunksReply {
    return decodePreviewChunksReply({ kind: "unauthorized", targetId });
  }

  #unavailableChunks(target: PreviewTarget): PreviewChunksReply {
    return decodePreviewChunksReply({ kind: "unavailable", target });
  }
}

/**
 * The set of preview kinds this slice can stream chunks for. Used by the
 * closed viewer registry on the renderer side. Formats outside this set
 * surface as `unsupported` through the typed outcome rather than streaming.
 */
export const STREAMABLE_PREVIEW_KINDS: ReadonlyArray<PreviewKind> = [
  "text",
  "markdown",
  "image",
  "pdf",
  "table",
  "workbook",
  "document",
  "slides",
];
