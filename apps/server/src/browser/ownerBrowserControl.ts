import { UtcTimestamp, type AuditActingPrincipal } from "@octant/contracts";
import {
  MAX_OWNER_BROWSER_CONTROL_MS,
  OwnerBrowserFrame,
  decodeOwnerBrowserControlId,
  type OwnerBrowserControl,
  type OwnerBrowserControlId,
  type OwnerBrowserInput,
  type OwnerBrowserRequest,
  type OwnerBrowserResponse,
  type OwnerBrowserTarget,
  type OwnerBrowserTargetDescriptor,
} from "@octant/contracts/owner-browser";
import {
  decideOwnerBrowserTakeOver,
  decideOwnerBrowserUse,
  sameOwnerBrowserTarget,
} from "@octant/domain";
import { Schema } from "effect";

export interface OwnerBrowserActor {
  readonly principal: AuditActingPrincipal;
  readonly name: string;
  readonly current: () => boolean;
  readonly freshOwnUnlock: boolean;
  /** Server process clock, captured when the own-class proof was verified. */
  readonly unlockDeadline: number;
}

export interface OwnerBrowserAuditFact {
  readonly principal: Extract<AuditActingPrincipal, { readonly kind: "owner-unlock" }>;
  readonly controlId: OwnerBrowserControlId;
  readonly target: OwnerBrowserTarget;
  readonly operation: "take-over" | "input" | "hand-back" | "revoke";
  readonly phase: "admitted" | "completed" | "possible";
  readonly inputKind?: OwnerBrowserInput["kind"];
}

export interface OwnerBrowserHost {
  readonly authorityCurrent: (target: OwnerBrowserTarget) => boolean;
  readonly targets: () => Promise<ReadonlyArray<typeof OwnerBrowserTargetDescriptor.Type>>;
  readonly inspect: (target: OwnerBrowserTarget) => Promise<OwnerBrowserTarget | undefined>;
  readonly privateHeld: (target: OwnerBrowserTarget) => boolean;
  readonly claim: (
    target: OwnerBrowserTarget,
    controlId: OwnerBrowserControlId,
    ownerName: string,
    expiresAt: OwnerBrowserControl["expiresAt"],
  ) => Promise<boolean>;
  readonly frame: (
    target: OwnerBrowserTarget,
    controlId: OwnerBrowserControlId,
    sequence: number,
    signal?: AbortSignal,
  ) => Promise<
    | { readonly status: "frame"; readonly frame: typeof OwnerBrowserFrame.Type }
    | { readonly status: "refused" }
  >;
  readonly input: (
    target: OwnerBrowserTarget,
    controlId: OwnerBrowserControlId,
    sequence: number,
    expectedFrame: number,
    input: OwnerBrowserInput,
    signal?: AbortSignal,
  ) => Promise<
    | { readonly status: "input"; readonly effect: "none" | "possible" | "completed" }
    | { readonly status: "refused" }
  >;
  /** Revoke only its own controller. Revoke leaves the existing person hold. */
  readonly release: (
    target: OwnerBrowserTarget,
    controlId: OwnerBrowserControlId,
    disposition: "revoke" | "hand-back",
  ) => Promise<{ readonly status: "released" | "refused" }>;
}

interface HeldControl {
  readonly abort: AbortController;
  readonly id: OwnerBrowserControlId;
  readonly target: OwnerBrowserTarget;
  readonly actor: OwnerBrowserActor;
  readonly principal: Extract<AuditActingPrincipal, { readonly kind: "owner-unlock" }>;
  readonly deadline: number;
  readonly expiresAt: OwnerBrowserControl["expiresAt"];
  readonly timer: ReturnType<typeof setTimeout>;
  nextSequence: number;
  frameSequence: number;
  busy: boolean;
}

export interface OwnerBrowserControlOptions {
  readonly host: OwnerBrowserHost;
  readonly now: () => number;
  readonly timestamp: () => string;
  readonly uuid: () => string;
  readonly audit: (fact: OwnerBrowserAuditFact) => void;
  readonly onReclaim?: (
    listener: (contextId: OwnerBrowserTarget["contextId"]) => void,
  ) => () => void;
  readonly onAuthorityChange?: (listener: () => void) => () => void;
}

export class OwnerBrowserControlService {
  readonly #input: OwnerBrowserControlOptions;
  readonly #controls = new Map<string, HeldControl>();
  readonly #contexts = new Map<string, OwnerBrowserControlId>();
  #closed = false;
  readonly #removeReclaim: (() => void) | undefined;
  readonly #removeAuthority: (() => void) | undefined;

  constructor(input: OwnerBrowserControlOptions) {
    this.#input = input;
    this.#removeReclaim = input.onReclaim?.((contextId) => {
      void this.invalidate(contextId);
    });
    this.#removeAuthority = input.onAuthorityChange?.(() => this.revalidateAuthority());
  }

  async execute(
    actor: OwnerBrowserActor,
    command: OwnerBrowserRequest,
    signal?: AbortSignal,
  ): Promise<OwnerBrowserResponse> {
    if (this.#closed || signal?.aborted) return { status: "refused", reason: "unavailable" };
    if (actor.principal.kind !== "owner-unlock" || !actor.current())
      return { status: "refused", reason: "unauthorized" };
    if (command.kind === "targets") {
      const targets = await this.#input.host.targets();
      return actor.current() && !signal?.aborted
        ? { status: "targets", targets: targets.slice(0, 16) }
        : { status: "refused", reason: "unauthorized" };
    }
    if (command.kind === "take-over") return this.#takeOver(actor, command.target, signal);
    const held = this.#controls.get(command.controlId);
    if (held === undefined) return { status: "refused", reason: "expired" };
    if (command.kind === "stop") {
      if (
        actor.principal.kind !== "owner-unlock" ||
        String(actor.principal.memberId) !== String(held.principal.memberId) ||
        !actor.current() ||
        !held.actor.current()
      )
        return { status: "refused", reason: "unauthorized" };
      this.#forget(held);
      this.#audit(held, "revoke", "admitted");
      try {
        const result = await this.#input.host.release(held.target, held.id, "revoke");
        this.#audit(held, "revoke", result.status === "released" ? "completed" : "possible");
        return result.status === "released"
          ? { status: "released" }
          : { status: "refused", reason: "unavailable" };
      } catch {
        this.#audit(held, "revoke", "possible");
        return { status: "refused", reason: "unavailable" };
      }
    }
    if (held.busy) return { status: "refused", reason: "controller-busy" };
    const currentTarget =
      command.kind === "hand-back" ? held.target : await this.#input.host.inspect(held.target);
    const decision = decideOwnerBrowserUse({
      principal: actor.principal,
      ownerMemberId: held.principal.memberId,
      ownerCurrent: actor.current() && held.actor.current(),
      resourceCurrent:
        currentTarget !== undefined && this.#input.host.authorityCurrent(held.target),
      privateHeld: this.#input.host.privateHeld(held.target),
      now: this.#input.now(),
      expiresAt: held.deadline,
      target: held.target,
      currentTarget: currentTarget ?? held.target,
      sequence: command.sequence,
      expectedSequence: held.nextSequence,
      ...(command.kind === "input" ? { expectedFrame: command.expectedFrame } : {}),
      currentFrame: held.frameSequence,
    });
    if (decision.status === "refused") {
      if (
        decision.reason !== "unauthorized" &&
        decision.reason !== "stale-sequence" &&
        decision.reason !== "stale-frame"
      )
        await this.#revoke(held);
      return decision;
    }
    if (this.#controls.get(held.id) !== held || signal?.aborted)
      return { status: "refused", reason: "expired" };
    if (held.busy) return { status: "refused", reason: "controller-busy" };
    held.busy = true;
    held.nextSequence += 1;
    const operationSignal =
      signal === undefined ? held.abort.signal : AbortSignal.any([signal, held.abort.signal]);
    try {
      if (command.kind === "hand-back") {
        if (!this.#audit(held, "hand-back", "admitted"))
          return { status: "refused", reason: "audit-unavailable" };
        const released = await this.#input.host.release(held.target, held.id, "hand-back");
        if (released.status !== "released") return { status: "refused", reason: "unavailable" };
        if (!this.#current(held, actor, signal)) return { status: "refused", reason: "expired" };
        this.#forget(held);
        this.#audit(held, "hand-back", "completed");
        return { status: "released" };
      }
      if (command.kind === "input") {
        if (!this.#audit(held, "input", "admitted", command.input.kind))
          return { status: "refused", reason: "audit-unavailable", effect: "none" };
        if (!this.#current(held, actor, signal))
          return { status: "refused", reason: "expired", effect: "none" };
        let effect: "none" | "possible" | "completed" = "possible";
        held.frameSequence = 0;
        try {
          const result = await this.#input.host.input(
            held.target,
            held.id,
            command.sequence,
            command.expectedFrame,
            command.input,
            operationSignal,
          );
          effect = result.status === "input" ? result.effect : "none";
        } catch {
          /* A dispatched input cannot be undone or inferred absent. */
        }
        this.#audit(
          held,
          "input",
          effect === "possible" ? "possible" : "completed",
          command.input.kind,
        );
        if (!this.#current(held, actor, signal)) {
          await this.#revoke(held);
          return { status: "refused", reason: "expired", effect };
        }
        return { status: "input", effect, nextSequence: held.nextSequence };
      }
      const result = await this.#input.host.frame(
        held.target,
        held.id,
        command.sequence,
        operationSignal,
      );
      const freshTarget = await this.#input.host.inspect(held.target);
      if (
        !this.#current(held, actor, signal) ||
        freshTarget === undefined ||
        !sameOwnerBrowserTarget(held.target, freshTarget)
      ) {
        await this.#revoke(held);
        return { status: "refused", reason: "stale-target" };
      }
      if (result.status !== "frame") return { status: "refused", reason: "unavailable" };
      const frame = Schema.decodeUnknownOption(OwnerBrowserFrame)(result.frame);
      if (frame._tag === "None" || frame.value.documentRevision !== held.target.documentRevision)
        return { status: "refused", reason: "unavailable" };
      held.frameSequence = frame.value.sequence;
      return { status: "frame", control: this.#view(held), frame: frame.value };
    } catch {
      return { status: "refused", reason: "unavailable" };
    } finally {
      held.busy = false;
    }
  }

  async #takeOver(
    actor: OwnerBrowserActor,
    target: OwnerBrowserTarget,
    signal?: AbortSignal,
  ): Promise<OwnerBrowserResponse> {
    const currentTarget = await this.#input.host.inspect(target);
    const decision = decideOwnerBrowserTakeOver({
      principal: actor.principal,
      ownerCurrent: actor.current(),
      resourceCurrent:
        currentTarget !== undefined &&
        this.#input.host.authorityCurrent(target) &&
        sameOwnerBrowserTarget(target, currentTarget),
      privateHeld: this.#input.host.privateHeld(target),
      controllerBusy: this.#contexts.has(target.contextId) || this.#controls.size >= 16,
      freshOwnUnlock: actor.freshOwnUnlock && this.#input.now() < actor.unlockDeadline,
    });
    if (decision.status === "refused") return decision;
    if (actor.principal.kind !== "owner-unlock" || signal?.aborted || this.#closed)
      return { status: "refused", reason: "unauthorized" };
    const id = decodeOwnerBrowserControlId(this.#input.uuid());
    const lifetime = Math.min(
      MAX_OWNER_BROWSER_CONTROL_MS,
      actor.unlockDeadline - this.#input.now(),
    );
    const deadline = this.#input.now() + lifetime;
    const expiresAt = Schema.decodeUnknownSync(UtcTimestamp)(
      new Date(Date.parse(this.#input.timestamp()) + lifetime).toISOString(),
    );
    const timer = setTimeout(() => {
      const held = this.#controls.get(id);
      if (held !== undefined) void this.#revoke(held);
    }, lifetime);
    timer.unref?.();
    const held: HeldControl = {
      abort: new AbortController(),
      id,
      target,
      actor,
      principal: actor.principal,
      deadline,
      expiresAt,
      timer,
      nextSequence: 1,
      frameSequence: 0,
      busy: true,
    };
    this.#controls.set(id, held);
    this.#contexts.set(target.contextId, id);
    try {
      if (!this.#audit(held, "take-over", "admitted")) {
        this.#forget(held);
        return { status: "refused", reason: "audit-unavailable" };
      }
      const claimed = await this.#input.host.claim(target, id, actor.name, expiresAt);
      if (this.#controls.get(id) !== held) {
        if (claimed) await this.#input.host.release(target, id, "revoke");
        return { status: "refused", reason: "expired" };
      }
      if (!claimed || !this.#current(held, actor, signal)) {
        await this.#revoke(held);
        return { status: "refused", reason: "unavailable" };
      }
      if (!this.#audit(held, "take-over", "completed")) {
        await this.#revoke(held);
        return { status: "refused", reason: "audit-unavailable" };
      }
      return { status: "controlled", control: this.#view(held) };
    } catch {
      await this.#revoke(held);
      return { status: "refused", reason: "unavailable" };
    } finally {
      held.busy = false;
    }
  }

  #current(held: HeldControl, actor: OwnerBrowserActor, signal?: AbortSignal): boolean {
    return (
      !this.#closed &&
      !signal?.aborted &&
      this.#controls.get(held.id) === held &&
      this.#input.now() < held.deadline &&
      actor.current() &&
      held.actor.current() &&
      this.#input.host.authorityCurrent(held.target) &&
      !this.#input.host.privateHeld(held.target)
    );
  }
  #view(held: HeldControl): OwnerBrowserControl {
    return {
      id: held.id,
      target: held.target,
      expiresAt: held.expiresAt,
      controllerName: held.actor.name.slice(0, 128),
      nextSequence: held.nextSequence,
    };
  }
  #audit(
    held: HeldControl,
    operation: OwnerBrowserAuditFact["operation"],
    phase: OwnerBrowserAuditFact["phase"],
    inputKind?: OwnerBrowserInput["kind"],
  ): boolean {
    try {
      this.#input.audit({
        principal: held.principal,
        controlId: held.id,
        target: held.target,
        operation,
        phase,
        ...(inputKind === undefined ? {} : { inputKind }),
      });
      return true;
    } catch {
      return false;
    }
  }
  #forget(held: HeldControl): void {
    held.abort.abort();
    clearTimeout(held.timer);
    if (this.#controls.get(held.id) === held) this.#controls.delete(held.id);
    if (this.#contexts.get(held.target.contextId) === held.id)
      this.#contexts.delete(held.target.contextId);
  }
  async #revoke(held: HeldControl): Promise<void> {
    if (this.#controls.get(held.id) !== held) return;
    this.#forget(held);
    this.#audit(held, "revoke", "admitted");
    try {
      await this.#input.host.release(held.target, held.id, "revoke");
    } catch {
      /* The finite native lease still expires; the person hold is never released here. */
    }
  }
  async invalidate(contextId: OwnerBrowserTarget["contextId"]): Promise<void> {
    const id = this.#contexts.get(contextId);
    const held = id === undefined ? undefined : this.#controls.get(id);
    if (held !== undefined) await this.#revoke(held);
  }
  revalidateAuthority(): void {
    if (this.#closed) return;
    for (const held of this.#controls.values()) {
      let current = false;
      try {
        current = held.actor.current() && this.#input.host.authorityCurrent(held.target);
      } catch {
        /* Missing authoritative state revokes rather than preserves a lease. */
      }
      if (!current) void this.#revoke(held);
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#removeAuthority?.();
    this.#removeReclaim?.();
    await Promise.allSettled([...this.#controls.values()].map((held) => this.#revoke(held)));
  }
}
