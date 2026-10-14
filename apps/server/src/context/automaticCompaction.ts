import { createHash } from "node:crypto";
import {
  decodeContextCompactionId,
  type ContextCompactionId,
  type ContextSubjectRef,
  type KnownTokenMeasurement,
  type ProviderRuntimeEvent,
} from "@octant/contracts";

/** A compaction a runtime made by itself during a turn, as the turn saw it. */
export interface AutomaticCompactionSighting {
  /** Its place among the turn's own automatic compactions, counted from 1. */
  readonly position: number;
  /** The window before it, when the runtime or an earlier report said. */
  readonly tokensBefore?: KnownTokenMeasurement;
  /** The window after it, when the runtime said. */
  readonly tokensAfter?: number;
}

/**
 * Follows one turn's runtime events for the compactions in it.
 *
 * A turn runner keeps one per turn. It answers whether the runtime compacted
 * the session during the turn, which is what the turn's window breakdown needs,
 * and hands back each compaction the runtime made by itself so the runner can
 * journal it. A requested compaction is journaled by the command that asked
 * for it, so it is never handed back here.
 */
export class TurnCompactions {
  #position = 0;
  readonly #seen = new Set<string>();
  #compacted = false;
  /** The window at the turn's latest usage report. */
  #report: number | undefined;
  /** A compaction newer than that report, and the window it left, if said. */
  #since: { readonly tokensAfter: number | undefined } | undefined;

  /** Whether the runtime compacted the session during this turn. */
  get compacted(): boolean {
    return this.#compacted;
  }

  observe(event: ProviderRuntimeEvent): AutomaticCompactionSighting | undefined {
    if (event.kind === "usage") {
      if (event.contextTokens !== undefined) {
        this.#report = event.contextTokens;
        this.#since = undefined;
      }
      return undefined;
    }
    if (event.kind !== "context-compacted") return undefined;
    // An adapter numbers a session's events once, so the same notification
    // delivered twice is one compaction, not two.
    const key = `${String(event.sessionId)}\u0000${event.sequence}`;
    if (this.#seen.has(key)) return undefined;
    this.#seen.add(key);
    this.#compacted = true;
    const tokensBefore = this.#before(event.tokensBefore);
    this.#since = { tokensAfter: event.tokensAfter };
    if (event.trigger !== "automatic") return undefined;
    this.#position += 1;
    return {
      position: this.#position,
      ...(tokensBefore === undefined ? {} : { tokensBefore }),
      ...(event.tokensAfter === undefined ? {} : { tokensAfter: event.tokensAfter }),
    };
  }

  /**
   * The runtime's own figure first. Otherwise the turn's latest report,
   * unless a compaction since then changed the window it describes: that
   * compaction's figure after stands instead, and without one the report is
   * only an upper bound and says so.
   */
  #before(reported: number | undefined): KnownTokenMeasurement | undefined {
    if (reported !== undefined) {
      return { kind: "known", tokens: reported, accuracy: "provider-reported" };
    }
    if (this.#since?.tokensAfter !== undefined) {
      return { kind: "known", tokens: this.#since.tokensAfter, accuracy: "provider-reported" };
    }
    if (this.#report === undefined) return undefined;
    return {
      kind: "known",
      tokens: this.#report,
      accuracy: this.#since === undefined ? "provider-reported" : "conservative-heuristic",
    };
  }
}

/**
 * The id an automatic compaction is journaled under. It is derived from the
 * thread, the turn and the compaction's place among the turn's compactions,
 * so the same runtime notification seen again after a recovery maps to the
 * same id and is journaled once.
 */
export function automaticCompactionId(
  subject: ContextSubjectRef,
  turnKey: string,
  position: number,
): ContextCompactionId {
  const seed = [
    "context-compaction:automatic",
    String(subject.aggregateType),
    String(subject.aggregateId),
    turnKey,
    String(position),
  ].join("\u0000");
  const bytes = createHash("sha256").update(seed).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return decodeContextCompactionId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`,
  );
}
