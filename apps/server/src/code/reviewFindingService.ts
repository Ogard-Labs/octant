import {
  ActorId,
  CodeCheckoutId,
  CodeDigest,
  CodeFileId,
  CodeRelativePath,
  CodeThreadId,
  CorrelationId,
  EventId,
  UtcTimestamp,
  decodeCodeReviewFinding,
  type CodeReviewFinding,
  type CodeReviewFindingId,
  type CodeThread,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

export interface ReviewFindingPersistencePort {
  readonly journal: Pick<Journal, "append">;
  readonly readCodeThread: (threadId: typeof CodeThreadId.Type) => CodeThread | undefined;
  readonly readReviewFinding: (
    findingId: typeof CodeReviewFindingId.Type,
  ) => CodeReviewFinding | undefined;
  readonly readReviewFindings: (
    threadId: typeof CodeThreadId.Type,
  ) => ReadonlyArray<CodeReviewFinding>;
}

export interface ReviewFindingFilePort {
  readonly resolve: (input: {
    readonly fileId: typeof CodeFileId.Type;
    readonly threadId: typeof CodeThreadId.Type;
    readonly checkoutId: typeof CodeCheckoutId.Type;
    readonly path: typeof CodeRelativePath.Type;
    readonly digest: typeof CodeDigest.Type;
  }) =>
    | Readonly<{
        threadId: typeof CodeThreadId.Type;
        checkoutId: typeof CodeCheckoutId.Type;
        path: typeof CodeRelativePath.Type;
        digest: typeof CodeDigest.Type;
      }>
    | undefined;
}

export interface ReviewFindingAccessPort {
  readonly canAccessProject: (
    authenticatedWindowId: WindowId,
    projectId: ProjectId,
  ) => boolean | Promise<boolean>;
}

export class ReviewFindingServiceError extends Error {
  override readonly name = "ReviewFindingServiceError";

  constructor(readonly failure: "invalid" | "unauthorized" | "stale" | "unavailable") {
    super(`Code review finding is ${failure}.`);
  }
}

export class ReviewFindingService {
  readonly #persistence: ReviewFindingPersistencePort;
  readonly #access: ReviewFindingAccessPort;
  readonly #files: ReviewFindingFilePort;
  readonly #uuid: () => string;
  readonly #clock: () => string;

  constructor(options: {
    readonly persistence: ReviewFindingPersistencePort;
    readonly access: ReviewFindingAccessPort;
    readonly files: ReviewFindingFilePort;
    readonly uuid: () => string;
    readonly clock: () => string;
  }) {
    this.#persistence = options.persistence;
    this.#access = options.access;
    this.#files = options.files;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
  }

  async create(
    authenticatedWindowId: WindowId,
    input: Omit<CodeReviewFinding, "state" | "version" | "createdAt" | "updatedAt">,
  ): Promise<CodeReviewFinding> {
    const thread = await this.#authorize(authenticatedWindowId, input.threadId);
    if (thread.checkoutId !== input.checkoutId) throw new ReviewFindingServiceError("invalid");
    const file = this.#files.resolve({
      fileId: input.fileId,
      threadId: input.threadId,
      checkoutId: input.checkoutId,
      path: input.path,
      digest: input.fileDigest,
    });
    if (
      file === undefined ||
      file.threadId !== input.threadId ||
      file.checkoutId !== input.checkoutId ||
      file.path !== input.path ||
      file.digest !== input.fileDigest
    ) {
      throw new ReviewFindingServiceError("invalid");
    }
    let finding: CodeReviewFinding;
    try {
      const timestamp = Schema.decodeUnknownSync(UtcTimestamp)(this.#clock());
      finding = decodeCodeReviewFinding({
        ...input,
        state: "open",
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch {
      throw new ReviewFindingServiceError("invalid");
    }
    if (this.#persistence.readReviewFinding(finding.id) !== undefined) {
      throw new ReviewFindingServiceError("stale");
    }
    try {
      this.#append(finding, 0);
    } catch (error) {
      if (error instanceof ConcurrencyConflict) throw new ReviewFindingServiceError("stale");
      throw error;
    }
    return finding;
  }

  async changeState(
    authenticatedWindowId: WindowId,
    input: Readonly<{
      findingId: typeof CodeReviewFindingId.Type;
      expectedVersion: number;
      state: CodeReviewFinding["state"];
    }>,
  ): Promise<CodeReviewFinding> {
    const existing = this.#persistence.readReviewFinding(input.findingId);
    if (existing === undefined) throw new ReviewFindingServiceError("invalid");
    await this.#authorize(authenticatedWindowId, existing.threadId);
    if (existing.version !== input.expectedVersion) throw new ReviewFindingServiceError("stale");
    let finding: CodeReviewFinding;
    try {
      finding = decodeCodeReviewFinding({
        ...existing,
        state: input.state,
        version: existing.version + 1,
        updatedAt: this.#clock(),
      });
    } catch {
      throw new ReviewFindingServiceError("invalid");
    }
    try {
      this.#append(finding, existing.version);
    } catch (error) {
      if (error instanceof ConcurrencyConflict) throw new ReviewFindingServiceError("stale");
      throw error;
    }
    return finding;
  }

  async list(
    authenticatedWindowId: WindowId,
    threadId: typeof CodeThreadId.Type,
  ): Promise<ReadonlyArray<CodeReviewFinding>> {
    await this.#authorize(authenticatedWindowId, threadId);
    return this.#persistence.readReviewFindings(threadId);
  }

  async #authorize(
    authenticatedWindowId: WindowId,
    threadId: typeof CodeThreadId.Type,
  ): Promise<CodeThread> {
    const thread = this.#persistence.readCodeThread(threadId);
    if (thread === undefined) throw new ReviewFindingServiceError("invalid");
    if (!(await this.#access.canAccessProject(authenticatedWindowId, thread.projectId))) {
      throw new ReviewFindingServiceError("unauthorized");
    }
    return thread;
  }

  #append(finding: CodeReviewFinding, expectedVersion: number): void {
    const decodeEventId = Schema.decodeUnknownSync(EventId);
    const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
    const decodeActorId = Schema.decodeUnknownSync(ActorId);
    this.#persistence.journal.append({
      aggregate: { aggregateType: "code-review-finding", aggregateId: finding.id },
      expectedVersion,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName: "code.review-finding-updated@1",
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: { kind: "local-user", actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID) },
          occurredAt: Schema.decodeUnknownSync(UtcTimestamp)(this.#clock()),
          payload: { kind: "review-finding-updated", finding },
        },
      ],
    });
  }
}
