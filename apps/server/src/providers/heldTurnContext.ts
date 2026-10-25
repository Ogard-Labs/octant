import { createHash } from "node:crypto";
import type {
  ProviderContextBlock,
  ProviderRuntimeEvent,
  ProviderSessionId,
} from "@octant/contracts";
import {
  isStandingProviderContext,
  providerTurnContextDelta,
  type ProviderTurnContextDelta,
} from "@octant/provider-sdk/chat-conformance";

interface SessionHold {
  /** Digests of the standing blocks the native session provably holds. */
  readonly held: ReadonlySet<string>;
  /** Digests of the standing context the running turn carries, held once it completes. */
  readonly sending?: ReadonlySet<string>;
}

function blockDigest(block: ProviderContextBlock): string {
  return createHash("sha256").update(block.kind).update("\u0000").update(block.text).digest("hex");
}

/**
 * The standing context each provider-owned session already holds, so a turn on
 * a resumed session sends only what is new (see `providerTurnContextDelta`).
 *
 * A block counts as held only after a turn that carried it completed on that
 * same session: a failed or interrupted turn may never have reached the
 * runtime's history. A session started afresh holds nothing, and a compaction,
 * automatic or requested, drops everything, because the runtime keeps only a
 * share of earlier prompts that Octant cannot see. The record lives in memory
 * for the life of the server, so the first turn after a restart sends the
 * standing context once more; that costs one copy, never a missing one.
 *
 * It is keyed by Octant's provider session id, which a continued Chat, Work, or
 * Code session keeps across turns. Only a caller whose driver owns the
 * conversation may use it: a host-owned conversation is rebuilt from the
 * journal every turn and holds nothing between them.
 */
export class HeldTurnContext {
  readonly #sessions = new Map<string, SessionHold>();

  /**
   * What this turn sends. `resumed` is whether the turn runs on a native
   * session opened by resume; a started session holds nothing.
   */
  forTurn(input: {
    readonly sessionId: ProviderSessionId;
    readonly resumed: boolean;
    readonly context: ReadonlyArray<ProviderContextBlock> | undefined;
  }): ProviderTurnContextDelta {
    const key = String(input.sessionId);
    const context = input.context ?? [];
    const held = (input.resumed ? this.#sessions.get(key)?.held : undefined) ?? new Set<string>();
    const delta = providerTurnContextDelta({
      context,
      holds: (block) => held.has(blockDigest(block)),
      heldCount: held.size,
    });
    this.#sessions.set(key, {
      held,
      sending: new Set(context.filter(isStandingProviderContext).map(blockDigest)),
    });
    return delta;
  }

  /** Follows the session's turn: completion makes its context held; compaction clears it. */
  observe(event: ProviderRuntimeEvent): void {
    const key = String(event.sessionId);
    const session = this.#sessions.get(key);
    if (session === undefined) return;
    if (
      event.kind === "context-compacted" ||
      (event.kind === "usage" && event.promptRetention === "compacted")
    ) {
      this.#sessions.delete(key);
      return;
    }
    if (event.kind === "completed" && session.sending !== undefined) {
      this.#sessions.set(key, { held: session.sending });
    } else if (event.kind === "failed" || event.kind === "interrupted") {
      this.#sessions.set(key, { held: session.held });
    }
  }

  /** The session's window changed in a way Octant cannot follow. */
  forget(sessionId: ProviderSessionId): void {
    this.#sessions.delete(String(sessionId));
  }
}

/** One record per server process, shared by every surface that runs provider turns. */
export const heldTurnContext = new HeldTurnContext();
