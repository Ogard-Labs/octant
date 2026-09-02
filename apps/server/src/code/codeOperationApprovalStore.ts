import { createHash } from "node:crypto";
import {
  decodeCodeOperationApprovalReceipt,
  decodeCodeOperationApprovalChallenge,
  type CodeApprovalEffect,
  type CodeOperationApprovalChallenge,
  type CodeOperationApprovalReceipt,
  type WindowId,
} from "@octant/contracts";

const APPROVAL_TTL_MS = 5 * 60_000;

interface ApprovalGrant {
  readonly approvalId: string;
  readonly windowId: WindowId;
  readonly effectDigest: string;
  readonly contextDigest: string;
  readonly expiresAt: number;
}

interface ApprovalChallenge {
  readonly challenge: CodeOperationApprovalChallenge;
  readonly windowId: WindowId;
  readonly effect: CodeApprovalEffect;
  readonly contextDigest: string;
  readonly expiresAt: number;
}

export interface CodeApprovalValidationPort {
  validate(input: {
    readonly windowId: WindowId;
    readonly effect: CodeApprovalEffect;
    readonly contextDigest: string;
    readonly approvalId?: string;
  }): Promise<boolean>;
}

export interface CodeOperationApprovalStoreOptions {
  readonly uuid: () => string;
  readonly now: () => number;
  /**
   * Clamp every wall-clock reading from `now()` against a shared,
   * server-owned process-monotonic bound (see `ProcessAuthorityClock`) before it is used
   * for expiry math, so a host wall-clock rollback cannot revive an expired
   * Code operation approval. Defaults to the identity function.
   */
  readonly clampNow?: (wallClockMs: number) => number;
  /**
   * When the shared clock posture is `recovery-required`, refuse
   * to mint a new approval grant or challenge rather than issuing trust
   * against an unsafe clock. `validate`/`confirm` of an already-issued grant
   * still relies solely on the monotonic clamp, matching the fail-closed
   * posture policy established for remote trust issuance.
   */
  readonly clockPosture?: () => "ok" | "recovery-required";
}

/** A recoverable host-time condition, distinct from an invalid approval. */
export class CodeOperationApprovalUnavailableError extends Error {
  constructor() {
    super("Code operation approval is unavailable while host time recovery is required.");
    this.name = "CodeOperationApprovalUnavailableError";
  }
}

export class CodeOperationApprovalStore implements CodeApprovalValidationPort {
  readonly #grants = new Map<string, ApprovalGrant>();
  readonly #challenges = new Map<string, ApprovalChallenge>();
  readonly #clampNow: (wallClockMs: number) => number;
  readonly #clockPosture: () => "ok" | "recovery-required";

  constructor(private readonly options: CodeOperationApprovalStoreOptions) {
    this.#clampNow = options.clampNow ?? ((wallClockMs) => wallClockMs);
    this.#clockPosture = options.clockPosture ?? (() => "ok");
  }

  issue(input: {
    readonly windowId: WindowId;
    readonly effect: CodeApprovalEffect;
    readonly contextDigest: string;
  }): CodeOperationApprovalReceipt | undefined {
    // Read and clamp the authority clock exactly once before evaluating its
    // posture. A second final observation after the posture check could itself
    // detect a rollback and leave a newly minted approval valid against the
    // frozen high-water mark for much longer than its nominal TTL.
    const now = this.#now();
    this.#removeExpired(now);
    this.#requireIssuancePosture();
    return this.#createReceipt(input, now);
  }

  #createReceipt(
    input: {
      readonly windowId: WindowId;
      readonly effect: CodeApprovalEffect;
      readonly contextDigest: string;
    },
    now: number,
  ): CodeOperationApprovalReceipt {
    const approvalId = this.options.uuid();
    this.#grants.set(approvalId, {
      approvalId,
      windowId: input.windowId,
      effectDigest: approvalEffectDigest(input.effect),
      contextDigest: input.contextDigest,
      expiresAt: now + APPROVAL_TTL_MS,
    });
    return decodeCodeOperationApprovalReceipt({ approvalId });
  }

  prepare(
    input: {
      readonly windowId: WindowId;
      readonly effect: CodeApprovalEffect;
    } & Omit<CodeOperationApprovalChallenge, "challengeId" | "effectDigest">,
  ): CodeOperationApprovalChallenge | undefined {
    // Keep the effective time and the recovery posture from the same authority
    // observation; see `issue` for the fail-closed ordering requirement.
    const now = this.#now();
    this.#removeExpired(now);
    this.#requireIssuancePosture();
    const challengeId = this.options.uuid();
    const {
      windowId: _windowId,
      effect: _effect,
      contextDigest: _contextDigest,
      ...publicInput
    } = input;
    const challenge = decodeCodeOperationApprovalChallenge({
      ...publicInput,
      challengeId,
      effectDigest: approvalEffectDigest(input.effect),
      contextDigest: input.contextDigest,
    });
    this.#challenges.set(challengeId, {
      challenge,
      windowId: input.windowId,
      effect: input.effect,
      contextDigest: input.contextDigest,
      expiresAt: now + APPROVAL_TTL_MS,
    });
    return challenge;
  }

  confirm(input: {
    readonly windowId: WindowId;
    readonly challengeId: string;
  }): CodeOperationApprovalReceipt | undefined {
    const now = this.#now();
    this.#removeExpired(now);
    const pending = this.#challenges.get(input.challengeId);
    if (pending === undefined || pending.windowId !== input.windowId) return undefined;
    // Check recovery before consuming the challenge, so a user can retry the
    // same confirmed action after the host clock is corrected.
    this.#requireIssuancePosture();
    this.#challenges.delete(input.challengeId);
    return this.#createReceipt(
      {
        windowId: input.windowId,
        effect: pending.effect,
        contextDigest: pending.contextDigest,
      },
      now,
    );
  }

  async validate(input: Parameters<CodeApprovalValidationPort["validate"]>[0]): Promise<boolean> {
    this.#removeExpired(this.#now());
    const digest = approvalEffectDigest(input.effect);
    const grant =
      input.approvalId === undefined
        ? [...this.#grants.values()].find(
            (candidate) =>
              candidate.windowId === input.windowId && candidate.effectDigest === digest,
          )
        : this.#grants.get(input.approvalId);
    if (
      grant === undefined ||
      grant.windowId !== input.windowId ||
      grant.effectDigest !== digest ||
      grant.contextDigest !== input.contextDigest
    ) {
      return false;
    }
    this.#grants.delete(grant.approvalId);
    return true;
  }

  revokeWindow(windowId: WindowId): void {
    for (const [approvalId, grant] of this.#grants) {
      if (grant.windowId === windowId) this.#grants.delete(approvalId);
    }
    for (const [challengeId, pending] of this.#challenges) {
      if (pending.windowId === windowId) this.#challenges.delete(challengeId);
    }
  }

  #now(): number {
    return this.#clampNow(this.options.now());
  }

  #removeExpired(now: number): void {
    for (const [approvalId, grant] of this.#grants) {
      if (now >= grant.expiresAt) this.#grants.delete(approvalId);
    }
    for (const [challengeId, pending] of this.#challenges) {
      if (now >= pending.expiresAt) this.#challenges.delete(challengeId);
    }
  }

  #requireIssuancePosture(): void {
    if (this.#clockPosture() === "recovery-required") {
      throw new CodeOperationApprovalUnavailableError();
    }
  }
}

export function approvalEffectDigest(effect: CodeApprovalEffect): string {
  return createHash("sha256")
    .update(canonicalJson(normalizeEffect(effect)))
    .digest("hex");
}

export function approvalContextDigest(context: unknown): string {
  return createHash("sha256").update(canonicalJson(context)).digest("hex");
}

function normalizeEffect(effect: CodeApprovalEffect): unknown {
  if (effect.kind === "apple-action") {
    const { approval: _approval, ...request } = effect.request;
    return { ...effect, request };
  }
  if (effect.kind !== "operation") return effect;
  if (effect.command.kind !== "push-git" && effect.command.kind !== "create-pull-request") {
    return effect;
  }
  const { authorization: _authorization, ...command } = effect.command;
  return { ...effect, command };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
