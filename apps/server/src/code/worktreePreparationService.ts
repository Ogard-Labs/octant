import { lstat, realpath } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  WORKTREE_PREPARATION_UPDATED,
  decodeCodeOperationId,
  decodeUtcTimestamp,
  decodeWorktreePreparationUpdated,
  type EventActor,
  type ProviderExecutionPolicy,
  type WorktreePreparation,
  type ProjectAction,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";
import type { ManagedWorktreeReceipt } from "./managedWorktreeReceiptStore";
import type { RepositoryTestProcessPort } from "./repositoryTestProcessPort";

export interface WorktreePreparationContext {
  readonly receiptId: string;
  readonly root: string;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly current: () => boolean;
  readonly recipeCurrent: () => boolean;
}
export interface WorktreePreparationOptions {
  readonly journal: Pick<Journal, "append" | "latestAggregateEvent">;
  readonly loadReceipt: (id: string) => Promise<ManagedWorktreeReceipt | undefined>;
  readonly execute: RepositoryTestProcessPort["executeReviewedAction"];
  readonly actor: EventActor;
  readonly clock: () => string;
  readonly uuid: () => string;
  readonly readRecipe?: (projectId: string) => ProjectAction | undefined;
}
const aggregateType = "worktree-preparation";
const outputLimit = 64 * 1024;

/** A reviewed recipe is a task-scoped command, never a new grant. Status is
 * journaled before spawn; output is a bounded, host-lifetime tail. */
export class WorktreePreparationService {
  readonly #options: WorktreePreparationOptions;
  readonly #active = new Map<
    string,
    { readonly abort: AbortController; readonly done: Promise<void> }
  >();
  readonly #output = new Map<string, { text: string; truncated: boolean }>();
  #reconciled = false;
  constructor(options: WorktreePreparationOptions) {
    this.#options = options;
  }

  async context(input: {
    readonly receiptId: string;
    readonly threadId: string;
    readonly checkoutId: string;
    readonly projectId: string;
    readonly root: string;
    readonly executionPolicy: ProviderExecutionPolicy;
    readonly current: () => boolean;
  }): Promise<WorktreePreparationContext | undefined> {
    const receipt = await this.#options.loadReceipt(input.receiptId);
    if (
      receipt?.threadId !== input.threadId ||
      receipt.checkoutId !== input.checkoutId ||
      receipt.canonicalWorktreePath !== input.root ||
      receipt.state !== "ready"
    )
      return undefined;
    const identity = await lstat(input.root).catch(() => undefined);
    if (identity === undefined || !identity.isDirectory() || identity.isSymbolicLink())
      return undefined;
    return {
      receiptId: input.receiptId,
      root: input.root,
      executionPolicy: input.executionPolicy,
      current: () => {
        try {
          const fresh = lstatSync(input.root);
          return (
            input.current() &&
            fresh.isDirectory() &&
            !fresh.isSymbolicLink() &&
            fresh.dev === identity.dev &&
            fresh.ino === identity.ino
          );
        } catch {
          return false;
        }
      },
      recipeCurrent: () =>
        JSON.stringify(this.#options.readRecipe?.(input.projectId)) ===
        JSON.stringify(receipt.setupRecipe),
    };
  }

  /** Called only after owned-process reconciliation has finished. No recipe is replayed. */
  reconciled(): void {
    this.#reconciled = true;
  }

  async inspect(context: WorktreePreparationContext) {
    const receipt = await this.#options.loadReceipt(context.receiptId);
    if (
      receipt === undefined ||
      receipt.state !== "ready" ||
      receipt.canonicalWorktreePath !== context.root ||
      !context.current()
    )
      throw new Error("Worktree preparation authority is unavailable.");
    const latest = this.#options.journal.latestAggregateEvent({
      aggregateType,
      aggregateId: receipt.receiptId,
    });
    let preparation =
      latest === undefined
        ? receipt.setupRecipe === undefined
          ? undefined
          : { recipe: receipt.setupRecipe, state: "pending" as const }
        : decodeWorktreePreparationUpdated(latest.payload).preparation;
    if (preparation?.state === "running" && !this.#active.has(receipt.receiptId)) {
      preparation = {
        ...preparation,
        state: this.#reconciled ? "interrupted" : "cleanup-uncertain",
        completedAt: decodeUtcTimestamp(this.#options.clock()),
        reason: this.#reconciled
          ? "The host restarted. Choose Retry or Skip; setup was not replayed."
          : "Owned process cleanup has not been confirmed.",
      };
      if (this.#reconciled) this.#record(receipt, preparation);
    }
    const output = this.#output.get(receipt.receiptId);
    return {
      receiptId: receipt.receiptId,
      ...(preparation === undefined ? {} : { preparation }),
      output: output?.text ?? "",
      outputTruncated: output?.truncated ?? false,
    };
  }

  async ensure(context: WorktreePreparationContext): Promise<string | undefined> {
    const view = await this.inspect(context);
    if (
      view.preparation === undefined ||
      view.preparation.state === "succeeded" ||
      view.preparation.state === "skipped"
    )
      return undefined;
    if (view.preparation.state === "pending") {
      const refused = this.#refuses(context);
      if (refused !== undefined) return refused;
      await this.#start(context);
    } else if (view.preparation.state === "running")
      await this.#active.get(context.receiptId)?.done;
    const final = await this.inspect(context);
    return final.preparation?.state === "succeeded" || final.preparation?.state === "skipped"
      ? undefined
      : `Worktree setup is ${final.preparation?.state ?? "unavailable"}. Open Worktree setup to review output, Retry, or Skip before starting the task.`;
  }

  async command(
    context: WorktreePreparationContext,
    action: "inspect" | "retry" | "cancel" | "skip",
  ) {
    const view = await this.inspect(context);
    if (view.preparation === undefined || action === "inspect") return view;
    const active = this.#active.get(context.receiptId);
    if (action === "cancel") {
      active?.abort.abort();
      await active?.done;
    }
    if (action === "skip") {
      if (active !== undefined || view.preparation.state === "cleanup-uncertain")
        throw new Error("Cancel setup and confirm cleanup before skipping it.");
      const receipt = await this.#options.loadReceipt(context.receiptId);
      if (receipt === undefined || !context.current())
        throw new Error("Worktree authority changed.");
      this.#record(receipt, {
        ...view.preparation,
        state: "skipped",
        completedAt: decodeUtcTimestamp(this.#options.clock()),
        reason: "Preparation deliberately skipped by the person.",
      });
    }
    if (action === "retry") {
      const refusal = this.#refuses(context);
      if (refusal !== undefined) throw new Error(refusal);
      if (active !== undefined || view.preparation.state === "cleanup-uncertain")
        throw new Error(
          "A preparation process may still be running. Confirm cleanup before retrying.",
        );
      // Start returns immediately to inspection; the owned promise is bounded by
      // process timeout and is joined by ensure, cancellation, and shutdown.
      void this.#start(context).catch(() => undefined);
    }
    return this.inspect(context);
  }

  async close(): Promise<void> {
    const active = [...this.#active.values()];
    for (const run of active) run.abort.abort();
    await Promise.allSettled(active.map((run) => run.done));
  }

  #refuses(context: WorktreePreparationContext): string | undefined {
    if (!context.current()) return "Worktree authority changed. Review the checkout again.";
    if (context.executionPolicy === "plan")
      return "Plan cannot run setup. Choose Skip or change task access before Retry.";
    if (!context.recipeCurrent())
      return "The reviewed setup recipe changed. Skip this preparation or restore the reviewed recipe.";
    return undefined;
  }

  async #start(context: WorktreePreparationContext): Promise<void> {
    const existing = this.#active.get(context.receiptId);
    if (existing !== undefined) return existing.done;
    const abort = new AbortController();
    // Install the reservation synchronously, before receipt or filesystem reads.
    const done = Promise.resolve()
      .then(() => this.#run(context, abort))
      .finally(() => this.#active.delete(context.receiptId));
    this.#active.set(context.receiptId, { abort, done });
    return done;
  }

  async #run(context: WorktreePreparationContext, abort: AbortController): Promise<void> {
    const signal = abort.signal;
    const receipt = await this.#options.loadReceipt(context.receiptId);
    if (
      receipt?.setupRecipe === undefined ||
      receipt.state !== "ready" ||
      receipt.canonicalWorktreePath !== context.root ||
      this.#refuses(context) !== undefined
    )
      return;
    const recipe = receipt.setupRecipe;
    const running: WorktreePreparation = {
      recipe,
      state: "running",
      attemptId: decodeCodeOperationId(this.#options.uuid()),
      startedAt: decodeUtcTimestamp(this.#options.clock()),
    };
    this.#record(receipt, running);
    this.#output.set(receipt.receiptId, { text: "", truncated: false });
    let final: WorktreePreparation;
    let attempted = false;
    try {
      const root = await realpath(context.root);
      const cwd = await realpath(resolve(root, recipe.directory));
      const delta = relative(root, cwd);
      if (root !== context.root || delta === ".." || delta.startsWith(`..${sep}`))
        throw new Error("Setup folder is unavailable or leaves the checkout.");
      if (this.#refuses(context) !== undefined || signal.aborted)
        throw new Error("Setup authority changed before launch.");
      const authorityTimer = setInterval(() => {
        if (this.#refuses(context) !== undefined) abort.abort();
      }, 200);
      let result: Awaited<ReturnType<RepositoryTestProcessPort["executeReviewedAction"]>>;
      attempted = true;
      try {
        result = await this.#options.execute(
          {
            action: recipe,
            cwd,
            checkoutRoot: root,
            executionPolicy: context.executionPolicy,
            environment: {},
            timeoutMs: 10 * 60 * 1000,
            beforeLaunch: () => this.#refuses(context) === undefined,
            admitStart: () => this.#refuses(context) === undefined,
            onOutput: (chunk) => {
              const output = this.#output.get(receipt.receiptId);
              if (output === undefined) return;
              const text = output.text + new TextDecoder().decode(chunk);
              output.truncated ||= text.length > outputLimit;
              output.text = text.slice(-outputLimit);
            },
          },
          signal,
        );
      } finally {
        clearInterval(authorityTimer);
      }
      final = {
        ...running,
        state: result.cleanupUncertain
          ? "cleanup-uncertain"
          : result.termination === "cancelled"
            ? "cancelled"
            : result.termination === "exited" && result.exitCode === 0
              ? "succeeded"
              : "failed",
        completedAt: decodeUtcTimestamp(this.#options.clock()),
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        ...(result.termination === "timed-out"
          ? { reason: "Setup exceeded its ten minute limit." }
          : result.termination === "unavailable"
            ? { reason: "The confined setup process could not start." }
            : {}),
      };
    } catch {
      final = {
        ...running,
        state: attempted ? "cleanup-uncertain" : signal.aborted ? "cancelled" : "failed",
        completedAt: decodeUtcTimestamp(this.#options.clock()),
        reason: "Setup folder or task authority is unavailable. Review it before retrying.",
      };
    }
    this.#record(receipt, final);
  }

  #record(receipt: ManagedWorktreeReceipt, preparation: WorktreePreparation): void {
    const previous = this.#options.journal.latestAggregateEvent({
      aggregateType,
      aggregateId: receipt.receiptId,
    });
    const payload = decodeWorktreePreparationUpdated({
      kind: "worktree-preparation-updated",
      receiptId: receipt.receiptId,
      threadId: receipt.threadId,
      checkoutId: receipt.checkoutId,
      preparation,
      updatedAt: decodeUtcTimestamp(this.#options.clock()),
    });
    this.#options.journal.append({
      aggregate: { aggregateType, aggregateId: receipt.receiptId },
      expectedVersion: previous?.aggregateVersion ?? 0,
      events: [
        {
          eventId: this.#options.uuid(),
          eventName: WORKTREE_PREPARATION_UPDATED,
          eventVersion: 1,
          correlationId: this.#options.uuid(),
          actor: this.#options.actor,
          occurredAt: decodeUtcTimestamp(this.#options.clock()),
          payload,
        },
      ],
    });
  }
}
