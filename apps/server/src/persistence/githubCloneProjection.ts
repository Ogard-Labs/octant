import {
  decodeGithubCloneOperation,
  decodeGithubCloneRequested,
  decodeGithubCloneTransitioned,
  type EventEnvelope,
  type GithubCloneOperation,
  type GithubCloneTransitioned,
} from "@octant/contracts";
import type { Projection } from "./projection";
import type { SqliteConnection } from "./sqlitePort";

export const GITHUB_CLONE_AGGREGATE_TYPE = "github-clone";
export const GITHUB_CLONE_REQUESTED = "github.clone-requested@1";
export const GITHUB_CLONE_TRANSITIONED = "github.clone-transitioned@1";

const ACTIVE_STATES: ReadonlySet<GithubCloneOperation["state"]> = new Set([
  "awaiting-confirmation",
  "reserved",
  "cloning",
  "verifying",
  "attaching",
  "recovery-required",
]);

/**
 * Rebuildable in-memory managed-clone projection. Replays journaled clone
 * lifecycle events into current per-request operation state. Idempotent:
 * duplicate or out-of-order older versions never roll state back.
 */
export class GithubCloneProjection implements Projection {
  readonly name = "github-clones";
  readonly dependencies: ReadonlyArray<string> = [];
  readonly #byRequestId = new Map<string, GithubCloneOperation>();

  reset(_connection: SqliteConnection): void {
    this.clear();
  }

  apply(_connection: SqliteConnection, event: EventEnvelope): void {
    if (event.eventVersion !== 1) return;
    if (event.eventName === GITHUB_CLONE_REQUESTED) {
      this.applyRequested(decodeGithubCloneRequested(event.payload).operation);
      return;
    }
    if (event.eventName === GITHUB_CLONE_TRANSITIONED) {
      this.applyTransitioned(decodeGithubCloneTransitioned(event.payload), event.occurredAt);
    }
  }

  applyRequested(operationInput: GithubCloneOperation): void {
    const operation = decodeGithubCloneOperation(operationInput);
    const existing = this.#byRequestId.get(operation.requestId);
    if (existing !== undefined && existing.version >= operation.version) return;
    this.#byRequestId.set(operation.requestId, operation);
  }

  applyTransitioned(payloadInput: GithubCloneTransitioned, occurredAt: string): void {
    const payload = decodeGithubCloneTransitioned(payloadInput);
    const existing = this.#byRequestId.get(payload.requestId);
    if (existing === undefined) return;
    if (existing.version >= payload.version) return;
    const next = decodeGithubCloneOperation({
      ...existing,
      state: payload.toState,
      version: payload.version,
      updatedAt: occurredAt,
      ...(payload.repository === undefined ? {} : { repository: payload.repository }),
      ...(payload.failure === undefined ? {} : { failure: payload.failure }),
      ...(payload.bindingIssued === undefined ? {} : { bindingIssued: payload.bindingIssued }),
    });
    this.#byRequestId.set(next.requestId, next);
  }

  getByRequestId(requestId: string): GithubCloneOperation | undefined {
    return this.#byRequestId.get(requestId);
  }

  /**
   * One active operation exclusively reserves both its repository node
   * identity and its canonical destination digest.
   */
  findActiveConflict(input: {
    readonly nodeId: string;
    readonly digest: string;
  }): GithubCloneOperation | undefined {
    for (const operation of this.#byRequestId.values()) {
      if (!ACTIVE_STATES.has(operation.state)) continue;
      if (
        operation.repository.nodeId === input.nodeId ||
        operation.destination.digest === input.digest
      ) {
        return operation;
      }
    }
    return undefined;
  }

  list(): ReadonlyArray<GithubCloneOperation> {
    return [...this.#byRequestId.values()].sort((left, right) => {
      if (left.requestedAt === right.requestedAt) {
        return left.requestId.localeCompare(right.requestId);
      }
      return left.requestedAt < right.requestedAt ? 1 : -1;
    });
  }

  clear(): void {
    this.#byRequestId.clear();
  }
}
