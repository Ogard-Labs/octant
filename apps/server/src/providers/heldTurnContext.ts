import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ProviderContextBlock,
  ProviderRuntimeEvent,
  ProviderSessionId,
} from "@octant/contracts";
import {
  isStandingProviderContext,
  providerContextIdentity,
  providerTurnContextDelta,
  type ProviderTurnContextDelta,
} from "@octant/provider-sdk/chat-conformance";

/** Standing blocks by identity digest, each with the digest of the version held. */
type Holding = ReadonlyMap<string, string>;

interface SessionHold {
  /** The standing blocks the native session provably holds. */
  readonly held: Holding;
  /** The standing context the running turn carries, held once it completes. */
  readonly sending?: Holding;
  /** Whether the running turn's adapter said the runtime keeps its prompts. */
  readonly keeps?: boolean;
  /** Whether the running turn restates the whole context, superseding what was held. */
  readonly restates?: boolean;
}

/**
 * One session's holding, as a store keeps it: a block's digest alone when its
 * identity is its text, or `identity:version` digests for a keyed block.
 */
export interface HeldSessionRecord {
  readonly sessionId: string;
  readonly held: ReadonlyArray<string>;
}

/** Where the record is kept between server runs. */
export interface HeldTurnContextStore {
  readonly load: () => ReadonlyArray<HeldSessionRecord>;
  readonly save: (records: ReadonlyArray<HeldSessionRecord>) => void;
}

/** Sessions kept across a restart; the most recently changed survive. */
const MAX_STORED_SESSIONS = 256;
/** A standing context of more blocks than this is sent again after a restart. */
const MAX_STORED_DIGESTS = 64;
/** Version 1 files predate keyed blocks; they read as holding nothing, which costs one copy. */
const STORE_VERSION = 2;
const ENTRY = /^[0-9a-f]{64}(?::[0-9a-f]{64})?$/;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function versionDigest(block: ProviderContextBlock): string {
  return digest(`${block.kind}\u0000${block.text}`);
}

function identityDigest(block: ProviderContextBlock): string {
  return block.key === undefined ? versionDigest(block) : digest(providerContextIdentity(block));
}

function holdingOf(blocks: ReadonlyArray<ProviderContextBlock>): Holding {
  return new Map(
    blocks
      .filter(isStandingProviderContext)
      .map((block) => [identityDigest(block), versionDigest(block)]),
  );
}

function storedEntries(held: Holding): ReadonlyArray<string> {
  return [...held].map(([identity, version]) =>
    identity === version ? version : `${identity}:${version}`,
  );
}

function holdingFromEntries(entries: ReadonlyArray<string>): Holding {
  return new Map(
    entries.map((entry) => {
      const [identity = entry, version = identity] = entry.split(":");
      return [identity, version];
    }),
  );
}

/**
 * The record kept in Octant's host data directory, so the first turn on a
 * resumed session after a restart sends only what is new, as every later turn
 * does. The file holds provider session ids and SHA-256 digests of standing
 * blocks and their keys, never their text, and only its owner may read it. It is a
 * rebuildable view: a missing, unreadable, or malformed file holds nothing,
 * which costs one copy of the standing context, never a missing one.
 *
 * Writes are synchronous and replace the file whole. A record that dropped a
 * session's holdings (a compaction) has to reach the disk before the next turn
 * is sent, or a restart could leave out context the runtime no longer has.
 */
export class HeldTurnContextFile implements HeldTurnContextStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  load(): ReadonlyArray<HeldSessionRecord> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#filePath, "utf8"));
    } catch {
      return [];
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
    const file = parsed as { readonly version?: unknown; readonly sessions?: unknown };
    if (file.version !== STORE_VERSION || !Array.isArray(file.sessions)) return [];
    return file.sessions.slice(0, MAX_STORED_SESSIONS).flatMap((candidate: unknown) => {
      if (typeof candidate !== "object" || candidate === null) return [];
      const entry = candidate as { readonly sessionId?: unknown; readonly held?: unknown };
      if (typeof entry.sessionId !== "string" || entry.sessionId.length === 0) return [];
      if (!Array.isArray(entry.held) || entry.held.length > MAX_STORED_DIGESTS) return [];
      const held = entry.held.filter(
        (stored: unknown): stored is string => typeof stored === "string" && ENTRY.test(stored),
      );
      return held.length > 0 && held.length === entry.held.length
        ? [{ sessionId: entry.sessionId, held }]
        : [];
    });
  }

  save(records: ReadonlyArray<HeldSessionRecord>): void {
    const temporary = `${this.#filePath}.tmp`;
    try {
      mkdirSync(dirname(this.#filePath), { recursive: true });
      // The mode applies only to a file the write creates, so a temporary file
      // left by an interrupted write is removed rather than reused.
      rmSync(temporary, { force: true });
      writeFileSync(
        temporary,
        JSON.stringify({ version: STORE_VERSION, sessions: records.slice(0, MAX_STORED_SESSIONS) }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      renameSync(temporary, this.#filePath);
    } catch {
      // The record on disk may still claim holdings this write dropped, so it
      // is removed: the next run then finds nothing and sends the standing
      // context again, rather than leaving out what the runtime lost.
      try {
        rmSync(this.#filePath, { force: true });
      } catch {
        // Nothing more can be done without the file system.
      }
    }
  }
}

/**
 * The standing context each provider-owned session already holds, so a turn on
 * a resumed session sends only what is new (see `providerTurnContextDelta`).
 *
 * A block counts as held only after a turn that carried it completed on that
 * same session and reported, on its usage, that the runtime keeps its prompts
 * (`promptRetention: "kept"`): a failed or interrupted turn may never have
 * reached the runtime's history, yet a failed restatement may have, so it
 * leaves the session holding nothing; and an adapter that says nothing about
 * retention (ACP agents) never reports a compaction either, so a dropped copy
 * there would never be sent again. A session started afresh holds nothing,
 * and a compaction, automatic or requested, drops everything, because the
 * runtime keeps only a share of earlier prompts that Octant cannot see. With a
 * store attached the record outlives the server process, as the runtime's own
 * history does; without one, the first turn after a restart sends the
 * standing context once more, which costs one copy, never a missing one.
 *
 * It is keyed by Octant's provider session id, which a continued Chat, Work, or
 * Code session keeps across turns. Only a caller whose driver owns the
 * conversation may use it: a host-owned conversation is rebuilt from the
 * journal every turn and holds nothing between them.
 */
export class HeldTurnContext {
  readonly #sessions = new Map<string, SessionHold>();
  #store: HeldTurnContextStore | undefined;

  /**
   * Keeps the record in `store` from now on, starting from what it holds.
   * A session this process already follows keeps its own record.
   */
  persistTo(store: HeldTurnContextStore): void {
    this.#store = store;
    for (const record of [...store.load()].reverse()) {
      if (this.#sessions.has(record.sessionId)) continue;
      this.#sessions.set(record.sessionId, { held: holdingFromEntries(record.held) });
    }
  }

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
    const previous = this.#sessions.get(key)?.held;
    const held: Holding = (input.resumed ? previous : undefined) ?? new Map();
    const delta = providerTurnContextDelta({
      context,
      holds: (block) => held.get(identityDigest(block)) === versionDigest(block),
      heldIdentities: new Set(held.keys()),
      identify: identityDigest,
    });
    this.#touch(key, {
      held,
      sending: holdingOf(context),
      restates: delta.kind === "restated",
    });
    if (previous !== undefined && previous.size > 0 && held !== previous) this.#persist();
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
      if (session.held.size > 0) this.#persist();
      return;
    }
    if (event.kind === "usage" && event.promptRetention === "kept") {
      if (session.sending !== undefined) this.#sessions.set(key, { ...session, keeps: true });
    } else if (event.kind === "completed" && session.sending !== undefined) {
      const held = session.keeps === true ? session.sending : session.held;
      this.#touch(key, { held });
      if (!sameHolding(session.held, held)) this.#persist();
    } else if (event.kind === "failed" || event.kind === "interrupted") {
      // A failed restatement may still be in the runtime's history (Claude
      // reports usage before its failed result), where it supersedes blocks the
      // record would otherwise call held; holding nothing forces a full send.
      if (session.restates !== true) this.#sessions.set(key, { held: session.held });
      else {
        this.#sessions.set(key, { held: new Map() });
        if (session.held.size > 0) this.#persist();
      }
    }
  }

  /** The session's window changed in a way Octant cannot follow. */
  forget(sessionId: ProviderSessionId): void {
    const key = String(sessionId);
    const held = this.#sessions.get(key)?.held;
    this.#sessions.delete(key);
    if (held !== undefined && held.size > 0) this.#persist();
  }

  /** Records a session's holding as its most recent change. */
  #touch(key: string, session: SessionHold): void {
    this.#sessions.delete(key);
    this.#sessions.set(key, session);
  }

  /** Writes every session that holds anything, most recently changed first. */
  #persist(): void {
    if (this.#store === undefined) return;
    const records: HeldSessionRecord[] = [];
    for (const [sessionId, session] of [...this.#sessions].reverse()) {
      if (session.held.size === 0 || session.held.size > MAX_STORED_DIGESTS) continue;
      records.push({ sessionId, held: storedEntries(session.held) });
      if (records.length === MAX_STORED_SESSIONS) break;
    }
    this.#store.save(records);
  }
}

function sameHolding(left: Holding, right: Holding): boolean {
  if (left.size !== right.size) return false;
  for (const [identity, version] of left) if (right.get(identity) !== version) return false;
  return true;
}

/** One record per server process, shared by every surface that runs provider turns. */
export const heldTurnContext = new HeldTurnContext();
