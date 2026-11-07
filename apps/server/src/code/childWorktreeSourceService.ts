import { resolve } from "node:path";
import {
  CHILD_WORKTREE_SOURCE_UPDATED,
  CHILD_WORKTREE_SEED_UPDATED,
  decodeChildWorktreeSnapshotData,
  decodeChildWorktreeSourceUpdated,
  decodeChildWorktreeSeedUpdated,
  type ChildWorktreeSnapshotData,
  type ChildWorktreeSnapshot,
  type ChildWorktreeSourceReview,
  type EventActor,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";
import { secretGuardRefusal } from "../process/secretGuard";
import type { GitMutationPort } from "./gitMutationPort";
import type { GitObservationPort } from "./gitObservationPort";
import type { ManagedWorktreeReceipt } from "./managedWorktreeReceiptStore";

export interface ChildWorktreeSourceContext {
  readonly threadId: string;
  readonly checkoutId: string;
  readonly bindingRevisionId: string;
  readonly root: string;
  readonly head: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly current: () => boolean;
}
interface ChildWorktreeSourceOptions {
  readonly journal: Pick<Journal, "append" | "latestAggregateEvent">;
  readonly mutation: Pick<
    GitMutationPort,
    "snapshotWorkingTree" | "releaseCheckpoint" | "restoreWorkingTree"
  >;
  readonly observation: Pick<GitObservationPort, "observe">;
  readonly actor: EventActor;
  readonly clock: () => string;
  readonly uuid: () => string;
}
export type ChildWorktreeSourceResult =
  | { readonly status: "ready"; readonly review: ChildWorktreeSourceReview }
  | { readonly status: "refused"; readonly message: string };
const refuses = (message: string) => ({ status: "refused" as const, message });
const sourceAggregate = "child-worktree-source",
  seedAggregate = "child-worktree-seed";
function publicSnapshot(snapshot: ChildWorktreeSnapshotData): ChildWorktreeSnapshot {
  const { worktree: _worktree, index: _index, ...publicValue } = snapshot;
  return publicValue;
}

/** The person selects a checkpoint, never live files. Capturing and enabling
 * are separate journal decisions; a child's copy is also recorded before use. */
export class ChildWorktreeSourceService {
  readonly #options: ChildWorktreeSourceOptions;
  constructor(options: ChildWorktreeSourceOptions) {
    this.#options = options;
  }

  inspect(context: ChildWorktreeSourceContext): ChildWorktreeSourceReview {
    const previous = this.#latest(context.threadId)?.payload;
    const record = this.#bound(context);
    if (
      previous?.selected !== undefined &&
      (record === undefined || previous.selected.baseRevision !== context.head)
    )
      return {
        selection: "snapshot",
        selected: publicSnapshot(previous.selected),
        refusal:
          "This selected snapshot belongs to an older checkout or revision. Choose Committed revision, then capture and review again.",
      };
    return {
      selection: record?.selected === undefined ? "committed" : "snapshot",
      ...(record?.selected === undefined ? {} : { selected: publicSnapshot(record.selected) }),
      ...(record?.preview === undefined ? {} : { preview: publicSnapshot(record.preview) }),
    };
  }

  async selected(
    context: ChildWorktreeSourceContext,
  ): Promise<
    | { readonly status: "selected"; readonly snapshot?: ChildWorktreeSnapshotData }
    | { readonly status: "refused"; readonly message: string }
  > {
    if (!context.current())
      return refuses("The parent checkout changed. Review its child source again.");
    const previous = this.#latest(context.threadId)?.payload;
    if (previous?.selected !== undefined && this.#bound(context) === undefined)
      return refuses(
        "The selected snapshot belongs to another checkout. Choose Committed revision and capture again.",
      );
    const selected = previous?.selected;
    if (selected !== undefined && selected.baseRevision !== context.head)
      return refuses(
        "The selected snapshot belongs to another revision. Choose Committed revision or capture again.",
      );
    return { status: "selected", ...(selected === undefined ? {} : { snapshot: selected }) };
  }

  async command(
    context: ChildWorktreeSourceContext,
    action: "inspect" | "capture" | "use-committed" | "use-snapshot",
    snapshotId?: string,
  ): Promise<ChildWorktreeSourceResult> {
    if (!context.current())
      return refuses("The parent checkout changed. Review its child source again.");
    if (action === "inspect") return { status: "ready", review: this.inspect(context) };
    const latest = this.#latest(context.threadId);
    if (action === "use-committed") {
      this.#record(context, latest?.version ?? 0, {});
      return { status: "ready", review: this.inspect(context) };
    }
    const record = this.#bound(context);
    if (
      latest?.payload.selected !== undefined &&
      (record === undefined || latest.payload.selected.baseRevision !== context.head)
    )
      return refuses(
        "The selected source is stale. Choose Committed revision before capturing a replacement.",
      );
    if (action === "use-snapshot") {
      if (
        record?.preview === undefined ||
        record.preview.id !== snapshotId ||
        record.preview.baseRevision !== context.head
      )
        return refuses("That snapshot is stale. Capture and review the current source again.");
      this.#record(context, latest?.version ?? 0, {
        selected: record.preview,
        preview: record.preview,
      });
      return { status: "ready", review: this.inspect(context) };
    }
    if (context.executionPolicy === "plan")
      return refuses(
        "Plan cannot capture a checkpoint. Use Committed revision or change task access.",
      );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let anchorId: string | undefined;
    try {
      const before = await this.#options.observation.observe(context.root, controller.signal, {
        untrackedFiles: "all",
      });
      if (
        before.status !== "ready" ||
        before.head.kind === "unborn" ||
        before.head.oid !== context.head ||
        before.diff.truncated ||
        before.statusEntries.length > 256
      )
        return refuses(
          "The snapshot is incomplete or unsupported. Reduce the changed file set and capture again.",
        );
      for (const file of before.statusEntries) {
        if (
          secretGuardRefusal(resolve(context.root, file.path)) !== undefined ||
          (file.originalPath !== undefined &&
            secretGuardRefusal(resolve(context.root, file.originalPath)) !== undefined)
        )
          return refuses(
            "A changed file is protected. Exclude protected files before capturing current edits.",
          );
      }
      const captured = await this.#options.mutation.snapshotWorkingTree(
        {
          checkoutRoot: context.root,
          checkoutId: context.checkoutId,
          executionPolicy: context.executionPolicy,
        },
        controller.signal,
      );
      if (captured.status !== "captured")
        return refuses(
          "Current edits could not be captured completely. Check protected files and Git state, then capture again.",
        );
      anchorId = captured.anchorId;
      const after = await this.#options.observation.observe(context.root, controller.signal, {
        untrackedFiles: "all",
      });
      const stable = await this.#options.mutation.snapshotWorkingTree(
        {
          checkoutRoot: context.root,
          checkoutId: context.checkoutId,
          executionPolicy: context.executionPolicy,
          retention: "comparison",
        },
        controller.signal,
      );
      if (
        after.status !== "ready" ||
        after.stateToken !== before.stateToken ||
        stable.status !== "captured" ||
        JSON.stringify(stable.snapshot) !== JSON.stringify(captured.snapshot) ||
        captured.snapshot.head !== context.head ||
        !context.current() ||
        controller.signal.aborted
      )
        return refuses("The parent changed during capture. Capture and review a new snapshot.");
      const preview = decodeChildWorktreeSnapshotData({
        id: anchorId,
        baseRevision: context.head,
        capturedAt: this.#options.clock(),
        worktree: captured.snapshot.worktree,
        index: captured.snapshot.index,
        files: before.statusEntries
          .map((file) => ({
            path: file.path,
            index: file.index,
            worktree: file.worktree,
            ...(file.originalPath === undefined ? {} : { previousPath: file.originalPath }),
          }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      });
      this.#record(context, latest?.version ?? 0, {
        ...(record?.selected === undefined ? {} : { selected: record.selected }),
        preview,
      });
      anchorId = undefined;
      return { status: "ready", review: this.inspect(context) };
    } catch {
      return refuses("The snapshot could not be recorded. Inspect the checkout and capture again.");
    } finally {
      clearTimeout(timeout);
      if (anchorId !== undefined)
        await this.#options.mutation
          .releaseCheckpoint({
            checkoutRoot: context.root,
            checkoutId: context.checkoutId,
            anchorId,
            executionPolicy: context.executionPolicy,
          })
          .catch(() => undefined);
    }
  }

  applied(receipt: ManagedWorktreeReceipt): boolean {
    if (receipt.seed === undefined) return true;
    const latest = this.#options.journal.latestAggregateEvent({
      aggregateType: seedAggregate,
      aggregateId: receipt.receiptId,
    });
    if (latest === undefined) return false;
    const status = decodeChildWorktreeSeedUpdated(latest.payload);
    return status.snapshotId === receipt.seed.id && status.state === "applied";
  }

  /** A partial copy is never replayed onto files a child might have edited. */
  async apply(receipt: ManagedWorktreeReceipt): Promise<boolean> {
    const seed = receipt.seed;
    if (seed === undefined) return true;
    if (
      receipt.state !== "ready" ||
      seed.baseRevision !== receipt.expectedHead ||
      this.#options.journal.latestAggregateEvent({
        aggregateType: seedAggregate,
        aggregateId: receipt.receiptId,
      }) !== undefined
    )
      return false;
    this.#seedRecord(receipt, "applying", 0);
    let applied = false;
    try {
      if (
        seed.files.some(
          (file) =>
            secretGuardRefusal(resolve(receipt.canonicalWorktreePath, file.path)) !== undefined ||
            (file.previousPath !== undefined &&
              secretGuardRefusal(resolve(receipt.canonicalWorktreePath, file.previousPath)) !==
                undefined),
        )
      )
        return false;
      const result = await this.#options.mutation.restoreWorkingTree({
        checkoutRoot: receipt.canonicalWorktreePath,
        snapshot: { head: seed.baseRevision, worktree: seed.worktree, index: seed.index },
        executionPolicy: "approval-gated",
      });
      applied = result.status === "applied";
      return applied;
    } catch {
      return false;
    } finally {
      this.#seedRecord(receipt, applied ? "applied" : "failed", 1);
    }
  }

  #latest(threadId: string) {
    const latest = this.#options.journal.latestAggregateEvent({
      aggregateType: sourceAggregate,
      aggregateId: threadId,
    });
    return latest === undefined
      ? undefined
      : {
          version: latest.aggregateVersion,
          payload: decodeChildWorktreeSourceUpdated(latest.payload),
        };
  }
  #bound(context: ChildWorktreeSourceContext) {
    const record = this.#latest(context.threadId)?.payload;
    if (record === undefined) return undefined;
    if (
      record.checkoutId !== context.checkoutId ||
      record.bindingRevisionId !== context.bindingRevisionId ||
      record.root !== context.root
    ) {
      return undefined;
    }
    return record;
  }
  #record(
    context: ChildWorktreeSourceContext,
    expectedVersion: number,
    selection: {
      readonly selected?: ChildWorktreeSnapshotData;
      readonly preview?: ChildWorktreeSnapshotData;
    },
  ): void {
    this.#append(
      sourceAggregate,
      context.threadId,
      expectedVersion,
      CHILD_WORKTREE_SOURCE_UPDATED,
      decodeChildWorktreeSourceUpdated({
        kind: "child-worktree-source-updated",
        threadId: context.threadId,
        checkoutId: context.checkoutId,
        bindingRevisionId: context.bindingRevisionId,
        root: context.root,
        ...selection,
        updatedAt: this.#options.clock(),
      }),
    );
  }
  #seedRecord(
    receipt: ManagedWorktreeReceipt,
    state: "applying" | "applied" | "failed",
    version: number,
  ): void {
    this.#append(
      seedAggregate,
      receipt.receiptId,
      version,
      CHILD_WORKTREE_SEED_UPDATED,
      decodeChildWorktreeSeedUpdated({
        kind: "child-worktree-seed-updated",
        receiptId: receipt.receiptId,
        snapshotId: receipt.seed?.id,
        state,
        updatedAt: this.#options.clock(),
      }),
    );
  }
  #append(
    aggregateType: string,
    aggregateId: string,
    expectedVersion: number,
    eventName: string,
    payload: unknown,
  ): void {
    this.#options.journal.append({
      aggregate: { aggregateType, aggregateId },
      expectedVersion,
      events: [
        {
          eventId: this.#options.uuid(),
          eventName,
          eventVersion: 1,
          correlationId: this.#options.uuid(),
          actor: this.#options.actor,
          occurredAt: this.#options.clock(),
          payload,
        },
      ],
    });
  }
}
