import { randomBytes } from "node:crypto";
import type { EventActor, UtcTimestamp } from "@octant/contracts";
import type { CanvasId } from "@octant/contracts/canvas";
import {
  CANVAS_NETWORK_ACCESS_AGGREGATE_TYPE,
  CANVAS_NETWORK_ACCESS_CHANGED,
  CanvasNetworkAccessChanged,
  decodeCanvasNetworkAccessChanged,
} from "@octant/contracts/canvas-network";
import type { EventRegistry } from "../persistence/eventRegistry";
import type { Journal } from "../persistence/journal";

/**
 * Which Canvases a person has allowed the network for, and the tokens their
 * running pages hold. Canonical: docs/design/canvas.md § Allow network.
 *
 * The switch is a journaled fact: off until a person turns it on, and read
 * back from the journal after a restart. Each Canvas's changes are an
 * aggregate of their own, keyed by the Canvas, so erasing a Canvas (with its
 * thread or its Project) erases its switch with it. A token is not journaled:
 * it lives in memory, names one Canvas, and is the whole authority of a
 * page's request to the proxy, so it is forgotten when the switch goes off,
 * when it ages out, and at restart.
 */

/**
 * How long a page's token lives without being renewed (maintainer decision,
 * 2026-11-13). The window that holds an open page renews it well inside the
 * hour, so a page a person is looking at keeps its network, and a closed
 * page's token is gone within the hour whatever became of it.
 */
export const CANVAS_NETWORK_TOKEN_TTL_MS = 60 * 60 * 1_000;
/**
 * Live tokens one Canvas may hold: one per running page, and a Canvas is
 * rarely open in more than a few windows. The oldest is forgotten first, so
 * pages opened again and again cannot pile tokens up.
 */
export const CANVAS_NETWORK_MAX_TOKENS_PER_CANVAS = 8;

const JOURNAL_REPLAY_BATCH_SIZE = 1_000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function registerCanvasNetworkAccessEvents(registry: EventRegistry): EventRegistry {
  return registry.register(CANVAS_NETWORK_ACCESS_CHANGED, 1, CanvasNetworkAccessChanged);
}

export interface CanvasNetworkAccessServiceDependencies {
  readonly journal: Pick<Journal, "append" | "replayAggregate">;
  readonly uuid: () => string;
  /** The person at this machine: the only one who sets the switch. */
  readonly actor: EventActor;
  readonly clock: () => UtcTimestamp;
  readonly now?: () => number;
}

export class CanvasNetworkAccessService {
  readonly #dependencies: CanvasNetworkAccessServiceDependencies;
  readonly #now: () => number;
  /** Each Canvas's switch as the journal holds it, read the first time it is asked for. */
  readonly #switches = new Map<string, { allowed: boolean; version: number }>();
  /** Insertion order is age: the first token of a Canvas is its oldest. */
  readonly #tokens = new Map<
    string,
    {
      readonly canvasId: CanvasId;
      /** The single-use ticket the token's page was served for: what a renewal names. */
      readonly page: string | undefined;
      expiresAt: number;
    }
  >();

  constructor(dependencies: CanvasNetworkAccessServiceDependencies) {
    this.#dependencies = dependencies;
    this.#now = dependencies.now ?? Date.now;
  }

  isAllowed(canvasId: CanvasId): boolean {
    return this.#switch(canvasId).allowed;
  }

  /**
   * Record a person's choice for one Canvas. Turning it off forgets that
   * Canvas's tokens before this returns, so no request already on its way is
   * answered under a switch the person has turned off. The caller has decided
   * that a person at a local window is asking.
   */
  set(canvasId: CanvasId, allowed: boolean): void {
    const current = this.#switch(canvasId);
    if (current.allowed === allowed) return;
    if (!allowed) this.#revoke(canvasId);
    this.#dependencies.journal.append({
      aggregate: {
        aggregateType: CANVAS_NETWORK_ACCESS_AGGREGATE_TYPE,
        aggregateId: canvasId,
      },
      expectedVersion: current.version,
      events: [
        {
          eventId: this.#dependencies.uuid(),
          eventName: CANVAS_NETWORK_ACCESS_CHANGED,
          eventVersion: 1,
          correlationId: this.#dependencies.uuid(),
          actor: this.#dependencies.actor,
          occurredAt: this.#dependencies.clock(),
          payload: { canvasId, allowed },
        },
      ],
    });
    current.version += 1;
    current.allowed = allowed;
  }

  /**
   * A token for one running page of a Canvas, or nothing while its switch is
   * off. `page` is the ticket the page was served for; a token minted without
   * one cannot be renewed.
   */
  issueToken(canvasId: CanvasId, page?: string): string | undefined {
    if (!this.isAllowed(canvasId)) return undefined;
    const now = this.#now();
    const own: string[] = [];
    for (const [token, entry] of this.#tokens) {
      if (now >= entry.expiresAt) this.#tokens.delete(token);
      else if (String(entry.canvasId) === String(canvasId)) own.push(token);
    }
    // Make room for the one being minted.
    const surplus = Math.max(0, own.length - CANVAS_NETWORK_MAX_TOKENS_PER_CANVAS + 1);
    for (const oldest of own.slice(0, surplus)) this.#tokens.delete(oldest);
    const token = randomBytes(32).toString("base64url");
    this.#tokens.set(token, { canvasId, page, expiresAt: now + CANVAS_NETWORK_TOKEN_TTL_MS });
    return token;
  }

  /**
   * The Canvas of the live token minted for a page, without renewing it, so a
   * caller can decide whether the asker may renew before anything changes.
   */
  canvasForPage(page: string): CanvasId | undefined {
    return this.#liveForPage(page)?.canvasId;
  }

  /**
   * Give an open page's token another hour, and answer its Canvas. The page
   * is named by its ticket, which the window that ran it holds, and never by
   * the token: a token that leaked renews nothing, and neither does using
   * one. A token that aged out or was revoked is not brought back.
   */
  renewPage(page: string): CanvasId | undefined {
    const entry = this.#liveForPage(page);
    if (entry === undefined) return undefined;
    entry.expiresAt = this.#now() + CANVAS_NETWORK_TOKEN_TTL_MS;
    return entry.canvasId;
  }

  #liveForPage(page: string) {
    const now = this.#now();
    for (const [token, entry] of this.#tokens) {
      if (entry.page !== page) continue;
      if (now >= entry.expiresAt || !this.isAllowed(entry.canvasId)) {
        this.#tokens.delete(token);
        return undefined;
      }
      return entry;
    }
    return undefined;
  }

  /**
   * The Canvas a live token names, or nothing: for a token never minted, aged
   * out, or revoked, and for one whose Canvas's switch is off, which is
   * checked here on every request rather than trusted to the revoke alone.
   */
  canvasForToken(token: string): CanvasId | undefined {
    if (!TOKEN.test(token)) return undefined;
    const entry = this.#tokens.get(token);
    if (entry === undefined) return undefined;
    if (this.#now() >= entry.expiresAt || !this.isAllowed(entry.canvasId)) {
      this.#tokens.delete(token);
      return undefined;
    }
    return entry.canvasId;
  }

  /**
   * Erased Canvases leave here with their journal: what was read of their
   * switch is dropped, so it is off again and is read afresh if the identity
   * is ever used again, and their pages' tokens are forgotten. Without this an
   * erased Canvas's running page kept the proxy until its token aged out.
   */
  forget(canvasIds: ReadonlyArray<string>): void {
    const erased = new Set(canvasIds);
    for (const canvasId of erased) this.#switches.delete(canvasId);
    for (const [token, entry] of this.#tokens) {
      if (erased.has(String(entry.canvasId))) this.#tokens.delete(token);
    }
  }

  #revoke(canvasId: CanvasId): void {
    for (const [token, entry] of this.#tokens) {
      if (String(entry.canvasId) === String(canvasId)) this.#tokens.delete(token);
    }
  }

  /** One Canvas's switch, replayed from its own aggregate the first time and kept after. */
  #switch(canvasId: CanvasId): { allowed: boolean; version: number } {
    const known = this.#switches.get(String(canvasId));
    if (known !== undefined) return known;
    const read = { allowed: false, version: 0 };
    for (;;) {
      const batch = this.#dependencies.journal.replayAggregate({
        aggregateType: CANVAS_NETWORK_ACCESS_AGGREGATE_TYPE,
        aggregateId: canvasId,
        afterVersion: read.version,
        limit: JOURNAL_REPLAY_BATCH_SIZE,
      });
      for (const envelope of batch) {
        read.version = envelope.aggregateVersion;
        if (envelope.eventName !== CANVAS_NETWORK_ACCESS_CHANGED) continue;
        try {
          read.allowed = decodeCanvasNetworkAccessChanged(envelope.payload).allowed;
        } catch {
          // A frame that no longer decodes turns nothing on: off is the
          // default, and the journal stays authoritative.
          read.allowed = false;
        }
      }
      if (batch.length < JOURNAL_REPLAY_BATCH_SIZE) break;
    }
    this.#switches.set(String(canvasId), read);
    return read;
  }
}
