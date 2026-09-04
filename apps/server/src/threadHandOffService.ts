import type { CanvasBlock } from "@octant/contracts/canvas";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import type {
  ProviderInstanceId,
  ProviderModelId,
  ProviderReadiness,
} from "@octant/contracts/providers";
import {
  decodeThreadHandOffOutcome,
  decodeThreadHandOffRequest,
  type ThreadHandOffOutcome,
  type ThreadHandOffRefusalReason,
  type ThreadHandOffRequest,
} from "@octant/contracts/thread-hand-off";
import type { WindowId } from "@octant/contracts";
import {
  buildThreadHandOffPrompt,
  decideThreadHandOff,
  threadHandOffDocumentBlocks,
  threadHandOffTitle,
  type ThreadExportActorKind,
} from "@octant/domain";
import type { ThreadExportService } from "./threadExportService";

/** How long the thread's provider has to write the document. */
const DEFAULT_COMPLETION_TIMEOUT_MS = 180_000;

export interface ThreadHandOffProviderPort {
  /** The host's last observed readiness for an enabled instance; absent when it has none. */
  readonly readiness: (providerInstanceId: ProviderInstanceId) => ProviderReadiness | undefined;
  /** One tool-free request to the thread's own provider and model. Rejects when it cannot answer. */
  readonly complete: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelId: ProviderModelId;
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
  }) => Promise<string>;
}

export interface ThreadHandOffDocumentPort {
  /** Keeps the document as a Canvas of the thread, through the same create path an author uses. */
  readonly save: (input: {
    readonly windowId: WindowId;
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly blocks: ReadonlyArray<CanvasBlock>;
  }) => Promise<
    | { readonly kind: "saved"; readonly canvasId: string; readonly versionId: string }
    | { readonly kind: "refused"; readonly message: string }
  >;
}

export interface ThreadHandOffServiceOptions {
  readonly exports: Pick<ThreadExportService, "exportThread">;
  readonly provider: ThreadHandOffProviderPort;
  readonly documents: ThreadHandOffDocumentPort;
  readonly completionTimeoutMs?: number;
}

/**
 * Host-authoritative hand-off of one thread.
 *
 * Starts from the export cut, so who may hand off is exactly who may export,
 * and a hidden thread is refused the same way. The cut also says whether a
 * turn is still running; a document written mid-turn would describe a moving
 * target, so that is refused before the provider is asked. The provider's
 * Markdown becomes a Canvas of the thread through the ordinary create path.
 */
export class ThreadHandOffService {
  readonly #exports: Pick<ThreadExportService, "exportThread">;
  readonly #provider: ThreadHandOffProviderPort;
  readonly #documents: ThreadHandOffDocumentPort;
  readonly #completionTimeoutMs: number;

  constructor(options: ThreadHandOffServiceOptions) {
    this.#exports = options.exports;
    this.#provider = options.provider;
    this.#documents = options.documents;
    this.#completionTimeoutMs = options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
  }

  async handOff(
    windowId: WindowId,
    actorKind: ThreadExportActorKind,
    input: unknown,
  ): Promise<ThreadHandOffOutcome> {
    let request: ThreadHandOffRequest;
    try {
      request = decodeThreadHandOffRequest(input);
    } catch {
      return refused("not-found");
    }
    const exported = await this.#exports.exportThread(windowId, actorKind, request);
    if (exported.kind === "refused") return refused(exported.reason);
    const bundle = exported.bundle;
    const decision = decideThreadHandOff(bundle);
    if (decision.kind === "refuse") return refused(decision.reason);
    const projectId = bundle.octant.projectId;
    if (projectId === undefined) return refused("project-required");

    const readiness = this.#provider.readiness(bundle.provenance.providerInstanceId);
    if (readiness !== "ready") {
      return refused(
        "provider-unavailable",
        readiness === undefined
          ? "This thread's provider is not available on this host."
          : `This thread's provider is ${readiness}.`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#completionTimeoutMs);
    let markdown: string;
    try {
      markdown = await this.#provider.complete({
        providerInstanceId: bundle.provenance.providerInstanceId,
        modelId: bundle.provenance.modelId,
        mode: request.mode,
        threadId: request.threadId,
        prompt: buildThreadHandOffPrompt(bundle),
        signal: controller.signal,
      });
    } catch {
      return refused(
        "document-not-produced",
        controller.signal.aborted
          ? "The provider did not finish the hand-off document in time."
          : "The provider did not produce a hand-off document.",
      );
    } finally {
      clearTimeout(timer);
    }
    const blocks = threadHandOffDocumentBlocks(markdown);
    if (blocks.length === 0) {
      return refused("document-not-produced", "The provider answered with an empty document.");
    }
    const title = threadHandOffTitle(bundle);
    const saved = await this.#documents.save({
      windowId,
      mode: request.mode,
      threadId: request.threadId,
      projectId,
      title,
      blocks,
    });
    if (saved.kind === "refused") return refused("document-refused", saved.message);
    return decodeThreadHandOffOutcome({
      kind: "handed-off",
      canvasId: saved.canvasId,
      versionId: saved.versionId,
      projectId,
      title,
    });
  }
}

/** The contract bounds a refusal message; a port's own denial text is not. */
const MAX_REFUSAL_MESSAGE_CHARS = 400;

function refused(reason: ThreadHandOffRefusalReason, message?: string): ThreadHandOffOutcome {
  return decodeThreadHandOffOutcome({
    kind: "refused",
    reason,
    // Clamped rather than passed through: a long Canvas denial would fail to
    // decode here and turn a refusal the person can read into a request that
    // simply failed.
    ...(message === undefined ? {} : { message: message.slice(0, MAX_REFUSAL_MESSAGE_CHARS) }),
  });
}
