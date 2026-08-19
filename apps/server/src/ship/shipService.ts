import {
  decodeShipCommand,
  decodeShipPlan,
  decodeShipReceipt,
  decodeShipResult,
  decodeShipTarget,
  SHIP_EVENT_NAMES,
  type ShipCommand,
  type ShipRefusalReason,
  type ShipResult,
  type ShipTarget,
  type UtcTimestamp,
} from "@octant/contracts";
import { decideShip, shipRefusalText, type ShipApproval } from "@octant/domain";

/**
 * Putting a build somewhere the person owns.
 *
 * The service holds no policy and no secret. It gathers what the host can
 * observe — the checkout, the reviewed revision, the build this host watched
 * being made, whether a credential is bound — asks the domain whether this
 * exact publication may happen, and either does it or records why it did not.
 *
 * Bytes go from this machine to the user's target. There is nothing in
 * between, by construction: the only thing this service can do is ask the
 * host's own Git port to push to a remote the checkout already has.
 */

export interface ShipCheckoutFacts {
  readonly checkoutRoot: string;
  readonly clean: boolean;
  readonly headRevision: string;
  /** The revision a review actually covered, when one did. */
  readonly reviewedRevision: string | undefined;
  readonly executionPolicy: "plan" | "approval-gated" | "auto-accept-edits" | "full-access";
}

export interface ShipArtifact {
  readonly digest: string;
  readonly producedByRunId: string;
}

export interface ShipDependencies {
  readonly listTargets: () => ReadonlyArray<ShipTarget>;
  readonly writeTarget: (target: ShipTarget) => void;
  readonly checkout: (threadId: string) => ShipCheckoutFacts | undefined;
  /**
   * The build this host watched being produced for that directory, measured by
   * the host rather than asserted by a caller.
   */
  readonly observedArtifact: (input: {
    readonly checkoutRoot: string;
    readonly artifactDirectory: string;
  }) => Promise<ShipArtifact | undefined>;
  /**
   * Resolve a bounded, purpose-scoped handle for a credential reference.
   *
   * The handle is what reaches the push; nothing here ever holds the value, and
   * a target with no reference resolves to nothing rather than to a default.
   */
  readonly credentialHandle: (
    reference: string,
  ) => Promise<{ readonly handleId: string } | undefined>;
  /**
   * Put the reviewed revision on the named remote branch. Never a relay.
   *
   * Bytes go from this machine to the user's own remote. There is nothing in
   * between and no Octant-hosted alternative to fall back to.
   */
  readonly publish: (input: {
    readonly checkoutRoot: string;
    readonly remoteName: string;
    readonly branch: string;
    readonly revision: string;
    readonly credentialHandleId: string;
  }) => Promise<
    { readonly outcome: "published" } | { readonly outcome: "failed"; readonly detail: string }
  >;
  /** An approval a person gave for exactly this act, if they did. */
  readonly approval: (approvalId: string) =>
    | {
        readonly targetId: string;
        readonly revision: string;
        readonly artifactDigest: string;
      }
    | undefined;
  readonly journal: {
    readonly append: (input: {
      readonly aggregateId: string;
      readonly eventName: string;
      readonly payload: unknown;
    }) => void;
  };
  readonly uuid: () => string;
  readonly clock: () => UtcTimestamp;
}

export class ShipService {
  readonly #dependencies: ShipDependencies;

  constructor(dependencies: ShipDependencies) {
    this.#dependencies = dependencies;
  }

  targets(): ReadonlyArray<ShipTarget> {
    return this.#dependencies.listTargets();
  }

  async execute(input: unknown): Promise<ShipResult> {
    let command: ShipCommand;
    try {
      command = decodeShipCommand(input);
    } catch {
      return this.#refused("target-not-found", "That is not a ship command this host serves.");
    }

    const target = this.#dependencies
      .listTargets()
      .find((candidate) => String(candidate.id) === String(command.targetId));
    if (target === undefined) {
      return this.#refused("target-not-found", "That target is not installed on this host.");
    }

    switch (command.kind) {
      case "enable-ship-target":
      case "bind-ship-credential": {
        if (target.version !== command.expectedVersion) {
          return this.#refused("target-not-found", "The target changed since you read it.");
        }
        const next = decodeShipTarget({
          ...target,
          ...(command.kind === "enable-ship-target"
            ? { enabled: command.enabled }
            : { credentialReference: command.credentialReference }),
          version: target.version + 1,
          updatedAt: this.#dependencies.clock(),
        });
        this.#dependencies.writeTarget(next);
        this.#dependencies.journal.append({
          aggregateId: String(next.id),
          eventName: SHIP_EVENT_NAMES.targetChanged,
          payload: { target: next },
        });
        return decodeShipResult({ kind: "ship-targets", targets: [next] });
      }
      case "plan-ship":
        return this.#plan(target, command.threadId);
      case "ship":
        return this.#ship(target, command);
    }
  }

  /**
   * Say what is about to be published before asking about it.
   *
   * A person approving a publication needs the target, the revision, and the
   * build named in front of them; approving "a deploy" is approving nothing in
   * particular.
   */
  async #plan(target: ShipTarget, threadId: string): Promise<ShipResult> {
    const checkout = this.#dependencies.checkout(threadId);
    if (checkout === undefined) {
      return this.#refused("target-not-found", "That thread has no checkout to publish from.");
    }
    const artifact = await this.#dependencies.observedArtifact({
      checkoutRoot: checkout.checkoutRoot,
      artifactDirectory: target.destination.artifactDirectory,
    });
    const decision = decideShip(this.#facts(target, checkout, artifact, { kind: "none" }));
    // Everything except the missing approval is a reason there is nothing to
    // approve. Only "approval-required" means the plan is worth showing.
    if (decision.decision === "refuse" && decision.reason !== "approval-required") {
      return this.#refused(decision.reason, shipRefusalText(decision.reason));
    }
    if (artifact === undefined) {
      return this.#refused("artifact-unobserved", shipRefusalText("artifact-unobserved"));
    }
    return decodeShipResult({
      kind: "ship-plan",
      plan: decodeShipPlan({
        targetId: target.id,
        targetName: target.displayName,
        destination: target.destination,
        revision: checkout.headRevision,
        artifactDigest: artifact.digest,
        producedByRunId: artifact.producedByRunId,
      }),
    });
  }

  async #ship(
    target: ShipTarget,
    command: Extract<ShipCommand, { readonly kind: "ship" }>,
  ): Promise<ShipResult> {
    const checkout = this.#dependencies.checkout(command.threadId);
    if (checkout === undefined) {
      return this.#refused("target-not-found", "That thread has no checkout to publish from.");
    }
    const artifact = await this.#dependencies.observedArtifact({
      checkoutRoot: checkout.checkoutRoot,
      artifactDirectory: target.destination.artifactDirectory,
    });
    const granted = this.#dependencies.approval(command.approvalId);
    const approval: ShipApproval =
      granted === undefined
        ? { kind: "none" }
        : {
            kind: "per-act",
            targetId: granted.targetId,
            revision: granted.revision,
            artifactDigest: granted.artifactDigest,
          };

    const decision = decideShip(this.#facts(target, checkout, artifact, approval));
    if (decision.decision === "refuse") {
      return this.#receipt(target, checkout.headRevision, artifact?.digest, {
        outcome: "refused",
        reason: decision.reason,
        detail: shipRefusalText(decision.reason),
      });
    }

    // Resolved at the moment of use and never held: the reference is what the
    // target stores, and only the host ever sees anything more than that.
    const handle =
      target.credentialReference === undefined
        ? undefined
        : await this.#dependencies.credentialHandle(target.credentialReference);
    if (handle === undefined) {
      return this.#receipt(target, checkout.headRevision, artifact?.digest, {
        outcome: "refused",
        reason: "credential-unbound",
        detail: shipRefusalText("credential-unbound"),
      });
    }

    const published = await this.#dependencies
      .publish({
        checkoutRoot: checkout.checkoutRoot,
        remoteName: target.destination.remoteName,
        branch: target.destination.branch,
        revision: checkout.headRevision,
        credentialHandleId: handle.handleId,
      })
      .catch(() => ({ outcome: "failed" as const, detail: "The publication could not be made." }));

    return published.outcome === "published"
      ? this.#receipt(target, checkout.headRevision, artifact?.digest, {
          outcome: "published",
          approvalId: command.approvalId,
        })
      : this.#receipt(target, checkout.headRevision, artifact?.digest, {
          outcome: "failed",
          reason: "publish-failed",
          detail: published.detail,
        });
  }

  #facts(
    target: ShipTarget,
    checkout: ShipCheckoutFacts,
    artifact: ShipArtifact | undefined,
    approval: ShipApproval,
  ) {
    return {
      targetId: String(target.id),
      targetEnabled: target.enabled,
      credentialBound: target.credentialReference !== undefined,
      executionPolicy: checkout.executionPolicy,
      checkoutClean: checkout.clean,
      headRevision: checkout.headRevision,
      reviewedRevision: checkout.reviewedRevision,
      artifact: {
        digest: artifact?.digest ?? "",
        observedDigest: artifact?.digest,
        producedByRunId: artifact?.producedByRunId,
      },
      approval,
    };
  }

  /**
   * Every outcome is journaled, including the refusals.
   *
   * What was published, to where, at which revision, and on whose decision has
   * to be answerable afterwards rather than reconstructed from a transcript —
   * and a refusal is just as much a part of that record.
   */
  #receipt(
    target: ShipTarget,
    revision: string,
    artifactDigest: string | undefined,
    outcome:
      | { readonly outcome: "published"; readonly approvalId: string }
      | {
          readonly outcome: "refused" | "failed";
          readonly reason: ShipRefusalReason;
          readonly detail: string;
        },
  ): ShipResult {
    const receipt = decodeShipReceipt({
      receiptId: this.#dependencies.uuid(),
      targetId: target.id,
      destination: target.destination,
      revision,
      // A refused ship still names the bytes it was about, and a zero digest
      // where none was observed says exactly that rather than inventing one.
      artifactDigest: artifactDigest ?? `sha256:${"0".repeat(64)}`,
      ...(outcome.outcome === "published"
        ? { outcome: "published" as const, approvalId: outcome.approvalId }
        : { outcome: outcome.outcome, reason: outcome.reason, detail: outcome.detail }),
      observedAt: this.#dependencies.clock(),
    });
    this.#dependencies.journal.append({
      aggregateId: String(target.id),
      eventName: SHIP_EVENT_NAMES.shipped,
      payload: { receipt },
    });
    return decodeShipResult({ kind: "ship-receipt", receipt });
  }

  #refused(reason: ShipRefusalReason, message: string): ShipResult {
    return decodeShipResult({ kind: "ship-refused", reason, message });
  }
}
