import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  GithubCloneProgress,
  decodeGithubCloneCommandResponse,
  decodeGithubCloneOperationList,
  type GithubAuthenticationSnapshot,
  type GithubCloneCommand,
  type GithubCloneCommandResponse,
  type GithubCloneFailure,
  type GithubCloneFailureCode,
  type GithubCloneOperation,
  type GithubCloneOperationList,
  type GithubCloneRefusalReason,
  type GithubCloneRepositoryFacts,
  type GithubCloneState,
  type WindowId,
} from "@octant/contracts";
import type { EventActor } from "@octant/contracts/events";
import {
  classifyManagedDestination,
  decideGithubCloneAuthorization,
  decideGithubCloneConfirmation,
  decideGithubCloneRecovery,
  deriveManagedRepositorySegments,
  isGithubCloneTransitionAllowed,
  normalizeGithubOriginUrl,
  verifyClonedRepository,
  type ManagedDestinationObservation,
} from "@octant/domain";
import { Schema } from "effect";
import type { BindingReceipt, BindingReceiptStorePort } from "../bindingReceiptStore";
import {
  GITHUB_CLONE_AGGREGATE_TYPE,
  GITHUB_CLONE_REQUESTED,
  GITHUB_CLONE_TRANSITIONED,
  type GithubCloneProjection,
} from "../persistence/githubCloneProjection";
import type { Journal } from "../persistence/journal";
import type { ProjectRootPort } from "../projectRootPort";
import type { ManagedCloneResult, ManagedGitResult } from "./managedCloneProcessPort";
import type {
  ManagedInventoryRefusalCode,
  ManagedRepositoryInventory,
} from "./managedRepositoryInventory";

const decodeProgress = Schema.decodeUnknownSync(GithubCloneProgress);

export interface ManagedCloneRepositoryFacts {
  readonly nodeId: string;
  readonly owner: string;
  readonly name: string;
  readonly visibility: "public" | "private" | "internal";
  readonly defaultBranch?: string;
}

/** One live normalized single-repository read; never served from a cache. */
export type ManagedCloneRepositoryObservation =
  | { readonly kind: "observed"; readonly repository: ManagedCloneRepositoryFacts }
  | { readonly kind: "not-found" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable" };

export interface ManagedCloneObservationPort {
  observeRepository(
    identity: { readonly owner: string; readonly name: string },
    signal: AbortSignal,
  ): Promise<ManagedCloneRepositoryObservation>;
}

export interface ManagedCloneProcessLike {
  clone(
    input: { readonly owner: string; readonly name: string; readonly stagingPath: string },
    onProgress: (message: string) => void,
    signal: AbortSignal,
  ): Promise<ManagedCloneResult>;
  runGit(args: readonly string[], signal: AbortSignal): Promise<ManagedGitResult>;
  hooksDirectory(): string;
}

export interface ManagedCloneServiceOptions {
  readonly journal: Pick<Journal, "append">;
  readonly projection: GithubCloneProjection;
  readonly inventory: ManagedRepositoryInventory;
  readonly process: ManagedCloneProcessLike;
  readonly observation: ManagedCloneObservationPort;
  readonly snapshot: (
    signal: AbortSignal,
  ) => Promise<Pick<GithubAuthenticationSnapshot, "state" | "account">>;
  readonly projectRootPort: Pick<ProjectRootPort, "validate">;
  readonly bindingReceiptStore: BindingReceiptStorePort;
  readonly actor: EventActor;
  readonly uuid?: () => string;
  readonly clock?: () => string;
  readonly now?: () => number;
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

/**
 * Server-authoritative managed-clone workflow: one explicitly confirmed
 * GitHub repository becomes one verified host-owned checkout plus one
 * ordinary Code Project binding receipt. Every lifecycle step is journaled
 * before its side effect is reported, every failure is terminal and
 * non-destructive, and stale catalogue data never authorizes an effect.
 */
export class ManagedCloneService {
  readonly #journal: Pick<Journal, "append">;
  readonly #projection: GithubCloneProjection;
  readonly #inventory: ManagedRepositoryInventory;
  readonly #process: ManagedCloneProcessLike;
  readonly #observation: ManagedCloneObservationPort;
  readonly #snapshot: ManagedCloneServiceOptions["snapshot"];
  readonly #projectRootPort: Pick<ProjectRootPort, "validate">;
  readonly #bindingReceiptStore: BindingReceiptStorePort;
  readonly #actor: EventActor;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #now: () => number;
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #progress = new Map<string, typeof GithubCloneProgress.Type>();

  constructor(options: ManagedCloneServiceOptions) {
    this.#journal = options.journal;
    this.#projection = options.projection;
    this.#inventory = options.inventory;
    this.#process = options.process;
    this.#observation = options.observation;
    this.#snapshot = options.snapshot;
    this.#projectRootPort = options.projectRootPort;
    this.#bindingReceiptStore = options.bindingReceiptStore;
    this.#actor = options.actor;
    this.#uuid = options.uuid ?? randomUUID;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#now = options.now ?? Date.now;
  }

  async execute(
    command: GithubCloneCommand,
    context: { readonly windowId: WindowId },
    signal: AbortSignal,
  ): Promise<GithubCloneCommandResponse> {
    try {
      switch (command.kind) {
        case "request-clone":
          return await this.#requestClone(command, signal);
        case "confirm-clone":
          return await this.#confirmClone(command, context.windowId);
        case "attach-existing":
          return await this.#attachExisting(command, context.windowId);
        case "cancel-clone":
          return await this.#cancelClone(command.requestId);
      }
    } catch {
      return { kind: "refused", reason: "unavailable" };
    }
  }

  list(): GithubCloneOperationList {
    return decodeGithubCloneOperationList({
      operations: this.#projection
        .list()
        .slice(0, 100)
        .map((operation) => {
          const progress = this.#progress.get(operation.requestId);
          return { operation, ...(progress === undefined ? {} : { progress }) };
        }),
    });
  }

  /**
   * Restart reconciliation. Interrupted operations become terminal or demand
   * explicit user attention; nothing is re-run or reported successful
   * silently, and leftover staging is quarantined, never deleted.
   */
  async recover(): Promise<void> {
    for (const operation of this.#projection.list()) {
      if (isTerminal(operation.state)) continue;
      const stagingExists = await this.#inventory.stagingExists(operation.requestId);
      const destination = await this.#inventory.observeDestination(
        operation.destination.destinationPath,
      );
      const action = decideGithubCloneRecovery({
        state: operation.state,
        mode: operation.mode,
        stagingExists,
        destinationExists: destination.exists,
      });
      if (action.action === "retain") continue;
      if (action.action === "recovery-required") {
        this.#transition(operation.requestId, "recovery-required", {});
        continue;
      }
      if (action.action === "quarantine-and-fail") {
        await this.#inventory.quarantine(operation.requestId);
      }
      this.#transition(operation.requestId, "failed", {
        failure: { code: action.code },
      });
    }
  }

  /** Server shutdown cancels every in-flight managed clone it owns. */
  close(): void {
    for (const run of this.#activeRuns.values()) {
      run.controller.abort(new Error("server-shutdown"));
    }
  }

  async #requestClone(
    command: Extract<GithubCloneCommand, { kind: "request-clone" }>,
    signal: AbortSignal,
  ): Promise<GithubCloneCommandResponse> {
    const existing = this.#projection.getByRequestId(command.requestId);
    if (existing !== undefined) {
      if (existing.repository.nodeId !== command.nodeId) {
        return this.#refuse("conflict");
      }
      return this.#respondOperation(existing);
    }
    const authorized = await this.#authorize(
      {
        nodeId: command.nodeId,
        owner: command.expectedOwner,
        name: command.expectedName,
      },
      signal,
    );
    if (authorized.outcome === "refused") return this.#refuse(authorized.reason);
    const repository = authorized.repository;
    const segments = deriveManagedRepositorySegments({
      owner: repository.owner,
      name: repository.name,
    });
    if (segments.kind !== "derived") return this.#refuse("invalid");
    const derivation = await this.#inventory.deriveDestination(segments.segments);
    if (derivation.status === "unavailable") return this.#refuse("unavailable");
    if (derivation.status === "refused") {
      if (derivation.code === "inventory-unavailable") return this.#refuse("unavailable");
      return this.#refuse("collision", derivation.code);
    }
    const destinationObservation = await this.#observeDestinationShape(
      derivation.destinationPath,
      repository,
      signal,
    );
    const classification = classifyManagedDestination(destinationObservation);
    if (classification.kind === "collision") {
      return this.#refuse("collision", classification.code);
    }
    const conflict = this.#projection.findActiveConflict({
      nodeId: repository.nodeId,
      digest: derivation.digest,
    });
    if (conflict !== undefined) return this.#refuse("conflict");
    const requestedAt = this.#clock();
    const operation: GithubCloneOperation = {
      requestId: command.requestId,
      state: "awaiting-confirmation",
      mode: classification.kind === "attachable" ? "attach-existing" : "clone",
      repository: toRepositoryFacts(repository),
      destination: {
        inventoryPath: derivation.inventoryPath,
        destinationPath: derivation.destinationPath,
        digest: derivation.digest,
      },
      version: 1,
      requestedAt,
      updatedAt: requestedAt,
    } as GithubCloneOperation;
    this.#journal.append({
      aggregate: {
        aggregateType: GITHUB_CLONE_AGGREGATE_TYPE,
        aggregateId: command.requestId,
      },
      expectedVersion: 0,
      events: [
        {
          eventId: this.#uuid(),
          eventName: GITHUB_CLONE_REQUESTED,
          eventVersion: 1,
          correlationId: this.#uuid(),
          actor: this.#actor,
          occurredAt: requestedAt,
          payload: { operation },
        },
      ],
    } as never);
    const current = this.#projection.getByRequestId(command.requestId);
    if (current === undefined) return this.#refuse("unavailable");
    return this.#respondOperation(current);
  }

  async #confirmClone(
    command: Extract<GithubCloneCommand, { kind: "confirm-clone" }>,
    windowId: WindowId,
  ): Promise<GithubCloneCommandResponse> {
    const operation = this.#projection.getByRequestId(command.requestId);
    if (operation === undefined) return this.#refuse("not-found");
    const confirmation = decideGithubCloneConfirmation({
      operation: {
        state: operation.state,
        nodeId: operation.repository.nodeId,
        destinationDigest: operation.destination.digest,
      },
      command: { nodeId: command.nodeId, destinationDigest: command.destinationDigest },
    });
    if (confirmation.decision === "deny") {
      return this.#refuse(confirmation.code === "state" ? "conflict" : "invalid");
    }
    if (operation.mode !== "clone") {
      return this.#refuse("conflict", "attach-existing-required");
    }
    if (this.#activeRuns.has(command.requestId)) return this.#refuse("conflict");
    return this.#ownRun(command.requestId, (runSignal) =>
      this.#runClonePipeline(operation, windowId, runSignal),
    );
  }

  async #attachExisting(
    command: Extract<GithubCloneCommand, { kind: "attach-existing" }>,
    windowId: WindowId,
  ): Promise<GithubCloneCommandResponse> {
    const operation = this.#projection.getByRequestId(command.requestId);
    if (operation === undefined) return this.#refuse("not-found");
    const confirmation = decideGithubCloneConfirmation({
      operation: {
        state: operation.state,
        nodeId: operation.repository.nodeId,
        destinationDigest: operation.destination.digest,
      },
      command: { nodeId: command.nodeId, destinationDigest: command.destinationDigest },
    });
    if (confirmation.decision === "deny") {
      return this.#refuse(confirmation.code === "state" ? "conflict" : "invalid");
    }
    if (operation.mode !== "attach-existing") {
      return this.#refuse("conflict", "managed-clone-required");
    }
    if (this.#activeRuns.has(command.requestId)) return this.#refuse("conflict");
    return this.#ownRun(command.requestId, (runSignal) =>
      this.#runAttachPipeline(operation, windowId, runSignal),
    );
  }

  async #cancelClone(requestId: string): Promise<GithubCloneCommandResponse> {
    const operation = this.#projection.getByRequestId(requestId);
    if (operation === undefined) return this.#refuse("not-found");
    const active = this.#activeRuns.get(requestId);
    if (active !== undefined) {
      active.controller.abort(new Error("managed-clone-cancelled"));
      await active.completion;
      const settled = this.#projection.getByRequestId(requestId);
      return settled === undefined ? this.#refuse("not-found") : this.#respondOperation(settled);
    }
    if (isTerminal(operation.state)) return this.#respondOperation(operation);
    if (operation.state !== "awaiting-confirmation" && operation.state !== "recovery-required") {
      await this.#inventory.quarantine(requestId);
    }
    const cancelled = this.#transition(requestId, "cancelled", {});
    return this.#respondOperation(cancelled);
  }

  async #ownRun(
    requestId: string,
    pipeline: (signal: AbortSignal) => Promise<GithubCloneCommandResponse>,
  ): Promise<GithubCloneCommandResponse> {
    const controller = new AbortController();
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#activeRuns.set(requestId, { controller, completion });
    try {
      return await pipeline(controller.signal);
    } finally {
      this.#activeRuns.delete(requestId);
      this.#progress.delete(requestId);
      settle();
    }
  }

  async #runClonePipeline(
    initial: GithubCloneOperation,
    windowId: WindowId,
    signal: AbortSignal,
  ): Promise<GithubCloneCommandResponse> {
    const requestId = initial.requestId;
    const expected = {
      nodeId: initial.repository.nodeId,
      owner: initial.repository.owner,
      name: initial.repository.name,
    };
    // Stale or changed repository facts never authorize the clone effect.
    const authorized = await this.#authorize(expected, signal);
    if (authorized.outcome === "refused") {
      return this.#fail(requestId, authorized.failureCode);
    }
    this.#transition(requestId, "reserved", {});
    if (signal.aborted) return this.#cancelRun(requestId, { quarantine: false });
    const staging = await this.#inventory.ensureStaging(requestId);
    if (staging.status !== "staged") {
      return this.#fail(
        requestId,
        staging.status === "unavailable"
          ? "inventory-unavailable"
          : stagingFailureCode(staging.code),
      );
    }
    this.#transition(requestId, "cloning", {});
    this.#recordProgress(requestId, "cloning");
    const cloneResult = await this.#process.clone(
      { owner: expected.owner, name: expected.name, stagingPath: staging.stagingPath },
      (message) => this.#recordProgress(requestId, "cloning", message),
      signal,
    );
    if (cloneResult.kind === "cancelled") {
      return this.#cancelRun(requestId, { quarantine: true });
    }
    if (cloneResult.kind === "timeout") {
      return this.#fail(requestId, "clone-timeout", { quarantine: true });
    }
    if (cloneResult.kind === "failed") {
      return this.#fail(requestId, "clone-failed", {
        quarantine: true,
        remediation: cloneResult.classification,
      });
    }
    if (signal.aborted) return this.#cancelRun(requestId, { quarantine: true });
    this.#transition(requestId, "verifying", {});
    this.#recordProgress(requestId, "verifying");
    const verification = await this.#verifyStaging(staging.stagingPath, expected, signal);
    if (verification.decision === "failed") {
      return this.#fail(requestId, verification.code, { quarantine: true });
    }
    if (!verification.empty) {
      const checkedOut = await this.#checkoutVerifiedObject(
        staging.stagingPath,
        verification.defaultBranch,
        verification.oid,
        signal,
      );
      if (!checkedOut) return this.#fail(requestId, "checkout-failed", { quarantine: true });
    }
    if (signal.aborted) return this.#cancelRun(requestId, { quarantine: true });
    this.#transition(requestId, "attaching", {});
    this.#recordProgress(requestId, "attaching");
    const promotion = await this.#inventory.promote(
      staging.stagingPath,
      initial.destination.destinationPath,
    );
    if (promotion.status !== "promoted") {
      return this.#fail(requestId, "promotion-failed", { quarantine: true });
    }
    // Post-promotion revalidation: the promoted checkout must still be the
    // confined, origin-verified repository before any authority is issued.
    const revalidated = await this.#revalidatePromoted(
      promotion.canonicalDestination,
      expected,
      signal,
    );
    if (!revalidated) return this.#fail(requestId, "revalidation-failed");
    const facts: GithubCloneRepositoryFacts = {
      ...initial.repository,
      ...(verification.defaultBranch === undefined
        ? {}
        : { defaultBranch: verification.defaultBranch }),
      empty: verification.empty,
    };
    return this.#issueBinding(requestId, promotion.canonicalDestination, windowId, facts);
  }

  async #runAttachPipeline(
    initial: GithubCloneOperation,
    windowId: WindowId,
    signal: AbortSignal,
  ): Promise<GithubCloneCommandResponse> {
    const requestId = initial.requestId;
    const expected = {
      nodeId: initial.repository.nodeId,
      owner: initial.repository.owner,
      name: initial.repository.name,
    };
    const authorized = await this.#authorize(expected, signal);
    if (authorized.outcome === "refused") {
      return this.#fail(requestId, authorized.failureCode);
    }
    this.#transition(requestId, "verifying", {});
    this.#recordProgress(requestId, "verifying");
    const destinationPath = initial.destination.destinationPath;
    const observation = await this.#observeDestinationShape(destinationPath, expected, signal);
    const classification = classifyManagedDestination(observation);
    if (classification.kind !== "attachable") {
      return this.#fail(
        requestId,
        classification.kind === "collision" ? classification.code : "destination-collision",
      );
    }
    if (!(await this.#inventory.isConfined(destinationPath))) {
      return this.#fail(requestId, "path-confinement");
    }
    if (signal.aborted) return this.#cancelRun(requestId, { quarantine: false });
    this.#transition(requestId, "attaching", {});
    this.#recordProgress(requestId, "attaching");
    const facts: GithubCloneRepositoryFacts = {
      ...initial.repository,
      ...(authorized.repository.defaultBranch === undefined
        ? {}
        : { defaultBranch: authorized.repository.defaultBranch }),
    };
    return this.#issueBinding(requestId, destinationPath, windowId, facts);
  }

  async #issueBinding(
    requestId: string,
    canonicalRootCandidate: string,
    windowId: WindowId,
    facts: GithubCloneRepositoryFacts,
  ): Promise<GithubCloneCommandResponse> {
    let receipt: BindingReceipt;
    try {
      const canonicalBinding = await this.#projectRootPort.validate("code", canonicalRootCandidate);
      receipt = this.#bindingReceiptStore.issue({
        windowId,
        projectType: "code",
        canonicalBinding,
        now: this.#now(),
      });
    } catch {
      // The verified checkout remains attached to no Project; it is
      // recoverable through the explicit attach flow and never deleted.
      return this.#fail(requestId, "binding-unavailable");
    }
    const completed = this.#transition(requestId, "completed", {
      repository: facts,
      bindingIssued: true,
    });
    return this.#respondOperation(completed, {
      receiptId: receipt.receiptId,
      projectType: "code",
      expiresAt: receipt.expiresAt,
    });
  }

  async #authorize(
    expected: { readonly nodeId: string; readonly owner: string; readonly name: string },
    signal: AbortSignal,
  ): Promise<
    | { readonly outcome: "allowed"; readonly repository: ManagedCloneRepositoryFacts }
    | {
        readonly outcome: "refused";
        readonly reason: GithubCloneRefusalReason;
        readonly failureCode: GithubCloneFailureCode;
      }
  > {
    const snapshot = await this.#snapshot(signal);
    const observation = await this.#observation.observeRepository(
      { owner: expected.owner, name: expected.name },
      signal,
    );
    const observed = observation.kind === "observed" ? observation.repository : undefined;
    const decision = decideGithubCloneAuthorization({
      snapshot,
      freshness: observation.kind === "observed" ? "fresh" : "stale",
      observed,
      expected,
    });
    if (decision.decision === "allow") {
      return { outcome: "allowed", repository: observed! };
    }
    switch (decision.code) {
      case "unauthorized":
        return { outcome: "refused", reason: "unauthorized", failureCode: "unauthorized" };
      case "non-https-git-protocol":
        return {
          outcome: "refused",
          reason: "non-https-git-protocol",
          failureCode: "non-https-git-protocol",
        };
      case "stale-read":
        if (observation.kind === "not-found") {
          return { outcome: "refused", reason: "not-found", failureCode: "stale-read" };
        }
        if (observation.kind === "unauthorized") {
          return { outcome: "refused", reason: "unauthorized", failureCode: "unauthorized" };
        }
        return { outcome: "refused", reason: "stale-read", failureCode: "stale-read" };
      case "node-identity-mismatch":
        return {
          outcome: "refused",
          reason: "conflict",
          failureCode: "node-identity-mismatch",
        };
      case "invalid-repository-identity":
        return {
          outcome: "refused",
          reason: "invalid",
          failureCode: "invalid-repository-identity",
        };
    }
  }

  /**
   * Observes what currently occupies a derived destination. Only a real,
   * non-bare, non-submodule checkout whose origin normalizes to the selected
   * repository is attachable; everything else is a collision.
   */
  async #observeDestinationShape(
    destinationPath: string,
    expected: { readonly owner: string; readonly name: string },
    signal: AbortSignal,
  ): Promise<ManagedDestinationObservation> {
    const shape = await this.#inventory.observeDestination(destinationPath);
    if (!shape.exists) return { exists: false };
    if (shape.kind !== "directory") return { exists: true, kind: shape.kind };
    if (shape.empty) return { exists: true, kind: "directory", checkout: "unverifiable" };
    const checkout = await this.#classifyExistingCheckout(destinationPath, expected, signal);
    return { exists: true, kind: "directory", checkout };
  }

  async #classifyExistingCheckout(
    path: string,
    expected: { readonly owner: string; readonly name: string },
    signal: AbortSignal,
  ): Promise<Exclude<ManagedDestinationObservation["checkout"], undefined>> {
    const bare = await this.#gitStdout(["-C", path, "rev-parse", "--is-bare-repository"], signal);
    if (bare === undefined) return "unverifiable";
    if (bare.trim() === "true") return "bare";
    const superproject = await this.#gitStdout(
      ["-C", path, "rev-parse", "--show-superproject-working-tree"],
      signal,
    );
    if (superproject === undefined) return "unverifiable";
    if (superproject.trim() !== "") return "submodule";
    const origin = await this.#gitStdout(["-C", path, "remote", "get-url", "origin"], signal);
    if (origin === undefined) return "unverifiable";
    const normalized = normalizeGithubOriginUrl(origin.trim());
    if (
      normalized === undefined ||
      normalized.owner !== expected.owner ||
      normalized.name !== expected.name
    ) {
      return "wrong-origin";
    }
    return "matching-verified";
  }

  async #verifyStaging(
    stagingPath: string,
    expected: { readonly nodeId: string; readonly owner: string; readonly name: string },
    signal: AbortSignal,
  ): Promise<ReturnType<typeof verifyClonedRepository>> {
    const stagingConfined = await this.#inventory.isConfined(stagingPath);
    const bare = await this.#gitStdout(
      ["-C", stagingPath, "rev-parse", "--is-bare-repository"],
      signal,
    );
    const commonDirectory = await this.#gitStdout(
      ["-C", stagingPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      signal,
    );
    const superproject = await this.#gitStdout(
      ["-C", stagingPath, "rev-parse", "--show-superproject-working-tree"],
      signal,
    );
    const worktrees = await this.#gitStdout(
      ["-C", stagingPath, "worktree", "list", "--porcelain"],
      signal,
    );
    const origin = await this.#gitStdout(
      ["-C", stagingPath, "remote", "get-url", "origin"],
      signal,
    );
    const remoteRefs = await this.#gitStdout(
      ["-C", stagingPath, "for-each-ref", "refs/remotes/origin"],
      signal,
    );
    if (
      bare === undefined ||
      commonDirectory === undefined ||
      superproject === undefined ||
      worktrees === undefined ||
      origin === undefined ||
      remoteRefs === undefined
    ) {
      return { decision: "failed", code: "verification-failed" };
    }
    const headRef = await this.#gitStdout(
      ["-C", stagingPath, "symbolic-ref", "refs/remotes/origin/HEAD"],
      signal,
    );
    const remoteHeadBranch = headRef?.trim().startsWith("refs/remotes/origin/")
      ? headRef.trim().slice("refs/remotes/origin/".length)
      : undefined;
    const resolvedHeadOid =
      remoteHeadBranch === undefined
        ? undefined
        : (
            await this.#gitStdout(
              ["-C", stagingPath, "rev-parse", `refs/remotes/origin/${remoteHeadBranch}`],
              signal,
            )
          )?.trim();
    const observation = await this.#observation.observeRepository(
      { owner: expected.owner, name: expected.name },
      signal,
    );
    return verifyClonedRepository({
      stagingConfined,
      bare: bare.trim() === "true",
      commonDirectoryConfined: commonDirectory.trim() === join(stagingPath, ".git"),
      submodule: superproject.trim() !== "",
      worktreeCount: worktrees.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length,
      originUrl: origin.trim(),
      expected,
      freshObservation: observation.kind === "observed" ? observation.repository : undefined,
      remoteRefsPresent: remoteRefs.trim() !== "",
      ...(remoteHeadBranch === undefined ? {} : { remoteHeadBranch }),
      ...(resolvedHeadOid === undefined ? {} : { resolvedHeadOid }),
    } as never);
  }

  /**
   * One hardened, non-interactive checkout of the verified object id: hooks
   * point at a server-owned empty directory, submodules never initialize,
   * and no filesystem monitor starts.
   */
  async #checkoutVerifiedObject(
    stagingPath: string,
    branch: string,
    oid: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const result = await this.#process.runGit(
      [
        "-C",
        stagingPath,
        "-c",
        `core.hooksPath=${this.#process.hooksDirectory()}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "submodule.recurse=false",
        "checkout",
        "--no-guess",
        "-B",
        branch,
        oid,
      ],
      signal,
    );
    return result.status === "completed" && result.exitCode === 0;
  }

  async #revalidatePromoted(
    canonicalDestination: string,
    expected: { readonly owner: string; readonly name: string },
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!(await this.#inventory.isConfined(canonicalDestination))) return false;
    const bare = await this.#gitStdout(
      ["-C", canonicalDestination, "rev-parse", "--is-bare-repository"],
      signal,
    );
    if (bare === undefined || bare.trim() !== "false") return false;
    const origin = await this.#gitStdout(
      ["-C", canonicalDestination, "remote", "get-url", "origin"],
      signal,
    );
    if (origin === undefined) return false;
    const normalized = normalizeGithubOriginUrl(origin.trim());
    return (
      normalized !== undefined &&
      normalized.owner === expected.owner &&
      normalized.name === expected.name
    );
  }

  async #gitStdout(args: readonly string[], signal: AbortSignal): Promise<string | undefined> {
    const result = await this.#process.runGit(args, signal);
    if (result.status !== "completed" || result.exitCode !== 0) return undefined;
    return result.stdout;
  }

  async #fail(
    requestId: string,
    code: GithubCloneFailureCode,
    options: { readonly quarantine?: boolean; readonly remediation?: string } = {},
  ): Promise<GithubCloneCommandResponse> {
    if (options.quarantine === true) await this.#inventory.quarantine(requestId);
    const failure: GithubCloneFailure = {
      code,
      ...(options.remediation === undefined ? {} : { remediation: options.remediation }),
    } as GithubCloneFailure;
    const failed = this.#transition(requestId, "failed", { failure });
    return this.#respondOperation(failed);
  }

  async #cancelRun(
    requestId: string,
    options: { readonly quarantine: boolean },
  ): Promise<GithubCloneCommandResponse> {
    if (options.quarantine) await this.#inventory.quarantine(requestId);
    const cancelled = this.#transition(requestId, "cancelled", {});
    return this.#respondOperation(cancelled);
  }

  #transition(
    requestId: string,
    toState: GithubCloneState,
    extras: {
      readonly failure?: GithubCloneFailure;
      readonly repository?: GithubCloneRepositoryFacts;
      readonly bindingIssued?: boolean;
    },
  ): GithubCloneOperation {
    const current = this.#projection.getByRequestId(requestId);
    if (current === undefined) throw new Error("managed-clone-operation-missing");
    if (!isGithubCloneTransitionAllowed(current.state, toState)) {
      throw new Error("managed-clone-transition-refused");
    }
    this.#journal.append({
      aggregate: { aggregateType: GITHUB_CLONE_AGGREGATE_TYPE, aggregateId: requestId },
      expectedVersion: current.version,
      events: [
        {
          eventId: this.#uuid(),
          eventName: GITHUB_CLONE_TRANSITIONED,
          eventVersion: 1,
          correlationId: this.#uuid(),
          actor: this.#actor,
          occurredAt: this.#clock(),
          payload: {
            requestId,
            fromState: current.state,
            toState,
            version: current.version + 1,
            ...(extras.failure === undefined ? {} : { failure: extras.failure }),
            ...(extras.repository === undefined ? {} : { repository: extras.repository }),
            ...(extras.bindingIssued === undefined ? {} : { bindingIssued: extras.bindingIssued }),
          },
        },
      ],
    } as never);
    const updated = this.#projection.getByRequestId(requestId);
    if (updated === undefined) throw new Error("managed-clone-operation-missing");
    return updated;
  }

  #recordProgress(
    requestId: string,
    phase: "cloning" | "verifying" | "attaching",
    message?: string,
  ): void {
    try {
      this.#progress.set(
        requestId,
        decodeProgress({ phase, ...(message === undefined ? {} : { message }) }),
      );
    } catch {
      // A message that fails the strict redaction contract is dropped whole.
      this.#progress.set(requestId, decodeProgress({ phase }));
    }
  }

  #respondOperation(
    operation: GithubCloneOperation,
    binding?: {
      readonly receiptId: string;
      readonly projectType: "code";
      readonly expiresAt: number;
    },
  ): GithubCloneCommandResponse {
    const progress = this.#progress.get(operation.requestId);
    return decodeGithubCloneCommandResponse({
      kind: "operation",
      operation,
      ...(progress === undefined ? {} : { progress }),
      ...(binding === undefined ? {} : { binding }),
    });
  }

  #refuse(reason: GithubCloneRefusalReason, remediation?: string): GithubCloneCommandResponse {
    return decodeGithubCloneCommandResponse({
      kind: "refused",
      reason,
      ...(remediation === undefined ? {} : { remediation }),
    });
  }
}

function isTerminal(state: GithubCloneState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function stagingFailureCode(code: ManagedInventoryRefusalCode): GithubCloneFailureCode {
  switch (code) {
    case "destination-collision":
      return "reservation-conflict";
    case "case-fold-collision":
      return "case-fold-collision";
    case "path-confinement":
      return "path-confinement";
    case "inventory-unavailable":
      return "inventory-unavailable";
  }
}

function toRepositoryFacts(repository: ManagedCloneRepositoryFacts): GithubCloneRepositoryFacts {
  return {
    nodeId: repository.nodeId,
    owner: repository.owner,
    name: repository.name,
    visibility: repository.visibility,
    ...(repository.defaultBranch === undefined ? {} : { defaultBranch: repository.defaultBranch }),
  } as GithubCloneRepositoryFacts;
}
