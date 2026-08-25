import { randomUUID } from "node:crypto";
import type {
  AgentRunAuthority,
  EventActor,
  LinkedThreadLimitSnapshot,
  LinkedThreadPreview,
  LinkedThreadPreviewCommand,
  LinkedThreadPromptPreviewCommand,
  LinkedThreadRoutingReceipt,
  LinkedThreadTargetResult,
  LinkedThreadTargetThreadId,
  UtcTimestamp,
  WindowId,
} from "@octant/contracts";
import { decodeLinkedThreadCreationReceipt } from "@octant/contracts";
import {
  admitLinkedThreadCreation,
  aggregateLinkedThreadResults,
  buildLinkedThreadPreview,
  classifyLinkedThreadPreviewTransition,
  parseLinkedThreadPrompt,
  resolveReviewInParallelSkillPrompt,
  REVIEW_IN_PARALLEL_SKILL_NAME,
  type LinkedThreadRouteSelection,
} from "@octant/domain";

const PREVIEW_TTL_MS = 5 * 60 * 1000;

export interface LinkedThreadCreationPort {
  readonly create: (input: {
    readonly authenticatedWindowId: WindowId;
    readonly preview: LinkedThreadPreview;
    readonly targets: ReadonlyArray<{
      readonly targetIndex: number;
      readonly label: string;
      readonly prompt: string;
      readonly threadId: LinkedThreadTargetThreadId;
    }>;
  }) => Promise<ReadonlyArray<LinkedThreadTargetResult>>;
}

export interface LinkedThreadServiceDependencies {
  readonly creation: LinkedThreadCreationPort;
  readonly selectRoute: (command: LinkedThreadPromptPreviewCommand) => LinkedThreadRouteSelection;
  readonly routingReceiptFor: (
    command: LinkedThreadPromptPreviewCommand,
  ) => LinkedThreadRoutingReceipt;
  readonly limitsFor: (input: {
    readonly command: LinkedThreadPromptPreviewCommand;
    readonly requestedCount: number;
  }) => LinkedThreadLimitSnapshot;
  readonly authorityCeiling: AgentRunAuthority;
  readonly targetAuthorityCeiling: AgentRunAuthority;
  readonly actor: EventActor;
  readonly now?: () => UtcTimestamp;
}

type StoredPreview = {
  readonly preview: LinkedThreadPreview;
  readonly command: LinkedThreadPromptPreviewCommand;
};

export class LinkedThreadService {
  readonly #creation: LinkedThreadCreationPort;
  readonly #selectRoute: LinkedThreadServiceDependencies["selectRoute"];
  readonly #routingReceiptFor: LinkedThreadServiceDependencies["routingReceiptFor"];
  readonly #limitsFor: LinkedThreadServiceDependencies["limitsFor"];
  readonly #authorityCeiling: AgentRunAuthority;
  readonly #targetAuthorityCeiling: AgentRunAuthority;
  readonly #actor: EventActor;
  readonly #now: () => UtcTimestamp;
  readonly #previews = new Map<string, StoredPreview>();

  constructor(dependencies: LinkedThreadServiceDependencies) {
    this.#creation = dependencies.creation;
    this.#selectRoute = dependencies.selectRoute;
    this.#routingReceiptFor = dependencies.routingReceiptFor;
    this.#limitsFor = dependencies.limitsFor;
    this.#authorityCeiling = dependencies.authorityCeiling;
    this.#targetAuthorityCeiling = dependencies.targetAuthorityCeiling;
    this.#actor = dependencies.actor;
    this.#now = dependencies.now ?? (() => new Date().toISOString() as UtcTimestamp);
  }

  previewSkill(input: {
    readonly task: string;
    readonly requestedCount: number;
    readonly command: LinkedThreadPromptPreviewCommand;
  }) {
    const resolved = resolveReviewInParallelSkillPrompt({
      task: input.task,
      requestedCount: input.requestedCount,
    });
    if (resolved.kind !== "linked-thread-fan-out") {
      return { code: "unsupported" as const, message: resolved.reason };
    }
    return this.previewPrompt({
      ...input.command,
      prompt: resolved.prompt,
      requestedAuthority: resolved.authority,
    });
  }

  previewPrompt(command: LinkedThreadPromptPreviewCommand) {
    this.#pruneExpiredPreviews(this.#now());
    const parsed = parseLinkedThreadPrompt({ prompt: command.prompt });
    if (parsed.kind === "unsupported") {
      return {
        kind: "unsupported" as const,
        reason: "The prompt does not request linked-thread fan-out.",
      };
    }
    const selection = this.#selectRoute(command);
    if (selection.kind === "denied") return selection;
    const built = buildLinkedThreadPreview({
      command,
      selection,
      routingReceipt: this.#routingReceiptFor(command),
      limits: this.#limitsFor({ command, requestedCount: parsed.requestedCount }),
      authorityCeiling: this.#authorityCeiling,
      proposedBy: this.#actor,
      previewId: randomUUID() as never,
      now: this.#now(),
      expiresAt: new Date(Date.parse(this.#now()) + PREVIEW_TTL_MS).toISOString() as UtcTimestamp,
    });
    if (built.kind === "unsupported" || built.kind === "denied" || built.kind === "unavailable")
      return built;
    this.#previews.set(String(built.preview.previewId), { preview: built.preview, command });
    return built;
  }

  async execute(authenticatedWindowId: WindowId, command: LinkedThreadPreviewCommand) {
    if (command.kind === "linked-thread-prompt-preview") {
      const outcome = this.previewPrompt(command);
      if (outcome.kind === "ready" || outcome.kind === "limited") {
        return { kind: "linked-thread-preview-proposed" as const, preview: outcome.preview };
      }
      if (outcome.kind === "unsupported")
        return { code: "unsupported" as const, message: outcome.reason };
      if (outcome.kind === "denied")
        return { code: "unavailable" as const, message: outcome.reason };
      return { code: "unauthorized" as const };
    }

    const previewId = String(command.previewId);
    this.#pruneExpiredPreviews(this.#now(), previewId);
    const stored = this.#previews.get(previewId);
    if (stored === undefined)
      return { code: "not-found" as const, message: "Linked-thread preview was not found." };
    const transition = command.kind === "confirm-linked-thread-preview" ? "confirm" : "deny";
    if (
      classifyLinkedThreadPreviewTransition({
        currentStatus: stored.preview.status,
        transition,
        expectedVersion: command.expectedVersion,
        currentVersion: stored.preview.version,
        now: this.#now(),
        expiresAt: stored.preview.expiresAt,
      }) === "deny"
    ) {
      this.#previews.delete(previewId);
      return { code: "stale" as const, message: "Linked-thread preview is no longer confirmable." };
    }

    if (command.kind === "deny-linked-thread-preview") {
      const denied = {
        ...stored.preview,
        status: "denied" as const,
        decidedAt: this.#now(),
        version: (stored.preview.version + 1) as never,
      };
      this.#previews.set(String(denied.previewId), { preview: denied, command: stored.command });
      return { kind: "linked-thread-preview-denied" as const, preview: denied };
    }

    const threadIds = Array.from(
      { length: stored.preview.requestedCount },
      () => randomUUID() as LinkedThreadTargetThreadId,
    );
    const promptBytes = Math.min(Buffer.byteLength(stored.preview.prompt, "utf8"), 128);
    const admission = admitLinkedThreadCreation({
      request: {
        kind: "create-linked-thread",
        requestId: stored.preview.requestId,
        requestFingerprint: stored.preview.requestFingerprint,
        targetThreadIds: [...threadIds],
        continuedFrom: {
          sourceThreadId: stored.preview.sourceThreadId,
          sourceScope: stored.preview.sourceScope,
          sourceVersion: stored.preview.sourceVersion,
          contextSnapshotId: stored.preview.contextSnapshotId,
          sourceRoutingReceipt: stored.preview.routingReceipt,
        },
        contextSnapshot: {
          id: stored.preview.contextSnapshotId,
          sourceThreadId: stored.preview.sourceThreadId,
          sourceVersion: stored.preview.sourceVersion,
          items: [
            {
              kind: "summary",
              referenceId: "linked-thread:preview",
              label: stored.preview.prompt.slice(0, 512),
              sourceVersion: stored.preview.sourceVersion,
              byteLength: promptBytes,
            },
          ],
          totalByteLength: promptBytes,
          trust: "untrusted-context",
        },
        targetScope: stored.preview.targetScope,
        routingReceipt: stored.preview.routingReceipt,
        requestedAuthority: stored.preview.effectiveAuthority,
        nestingDepth: stored.preview.nestingDepth,
      },
      receiptId: randomUUID(),
      targetAuthorityCeiling: this.#targetAuthorityCeiling,
      limits: this.#limitsFor({
        command: stored.command,
        requestedCount: stored.preview.requestedCount,
      }),
      targetScopeAvailable: true,
      targetScopeAuthorized: true,
      now: this.#now(),
    });
    if (admission.kind !== "accepted") {
      return { code: "unavailable" as const, message: "Linked-thread creation was not admitted." };
    }

    const attempted = await this.#creation.create({
      authenticatedWindowId,
      preview: stored.preview,
      targets: stored.preview.threads.map((thread, index) => ({
        targetIndex: thread.targetIndex,
        label: thread.label,
        prompt: thread.prompt,
        threadId: threadIds[index]!,
      })),
    });
    const byTargetIndex = new Map(attempted.map((result) => [result.targetIndex, result]));
    const results: ReadonlyArray<LinkedThreadTargetResult> = stored.preview.threads.map(
      (thread) =>
        byTargetIndex.get(thread.targetIndex) ?? {
          targetIndex: thread.targetIndex,
          label: thread.label,
          status: "failed",
          reason: "Linked-thread creation returned no result for this peer.",
        },
    );
    const createdThreadIds = results.flatMap((result) =>
      result.threadId !== undefined && threadIds.includes(result.threadId) ? [result.threadId] : [],
    );
    const receipt = decodeLinkedThreadCreationReceipt({
      ...admission.receipt,
      createdThreadIds,
      status:
        createdThreadIds.length === threadIds.length
          ? "accepted"
          : createdThreadIds.length > 0
            ? "partial"
            : "waiting",
      ...(createdThreadIds.length === 0
        ? { recoveryReason: "No linked review thread could be created." }
        : {}),
      updatedAt: this.#now(),
    });
    const aggregated = aggregateLinkedThreadResults({
      requestedCount: stored.preview.requestedCount,
      results,
    });
    const confirmed = {
      ...stored.preview,
      status: "confirmed" as const,
      decidedAt: this.#now(),
      version: (stored.preview.version + 1) as never,
    };
    const aggregate = {
      aggregateId: randomUUID() as never,
      requestId: stored.preview.requestId,
      receiptId: receipt.receiptId,
      previewId: stored.preview.previewId,
      sourceThreadId: stored.preview.sourceThreadId,
      skillName: REVIEW_IN_PARALLEL_SKILL_NAME,
      requestedCount: stored.preview.requestedCount,
      status: aggregated.status,
      results: [...aggregated.results],
      createdAt: this.#now(),
      updatedAt: this.#now(),
    };
    this.#previews.set(String(confirmed.previewId), {
      preview: confirmed,
      command: stored.command,
    });
    return {
      kind: "linked-thread-preview-confirmed" as const,
      preview: confirmed,
      receipt,
      aggregate,
    };
  }

  #pruneExpiredPreviews(now: UtcTimestamp, preservePreviewId?: string): void {
    const nowMs = Date.parse(now);
    for (const [previewId, stored] of this.#previews) {
      if (previewId === preservePreviewId) continue;
      if (Date.parse(stored.preview.expiresAt) <= nowMs) this.#previews.delete(previewId);
    }
  }
}
