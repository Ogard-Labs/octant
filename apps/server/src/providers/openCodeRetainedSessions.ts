import type { ProviderToolDefinition } from "@octant/contracts";

/**
 * How many resumed-session tool catalogues one driver keeps at once. A
 * catalogue exists only to carry a session's app-managed tools onto its next
 * resume; past the cap the oldest is dropped, and a resume that misses falls
 * back to the empty list — safe, because the session then installs no tool.
 */
const MAX_REMEMBERED_CATALOGS = 128;

/**
 * How long a catalogue waits for its resume. An evicted or expired entry only
 * means the resumed session starts with no app tools, never with another
 * session's.
 */
const REMEMBERED_CATALOG_MS = 30 * 60_000;

/**
 * How many stale-session tombstones are held before the registry refuses
 * every unknown resume. A session holding a turn's admitted-but-unrun
 * context must never be resumed; once the set cannot grow, the overflow
 * latch fails every unknown id closed rather than evicting a real denial.
 */
const MAX_STALE_SESSIONS = 4096;

/**
 * How many files one native process's `always` answers may be remembered to
 * at once. The ledger exists so OpenCode's saved grants, which it applies
 * without asking, are admitted only where an answer actually named them;
 * past the cap a batch is refused whole and the answer degrades to one-use.
 */
const MAX_REMEMBERED_EDITS = 1024;

/**
 * What one OpenCode driver remembers about native sessions that outlived the
 * connection or turn that made them: the tool catalogues a later resume may
 * need, and the sessions that must never be resumed again.
 *
 * Both are bounded. Past the cap the catalogue oldest last written is
 * evicted — reads do not refresh — and entries expire after the TTL, swept
 * on every read and write. Tombstones never expire and are never evicted:
 * when the set cannot grow, the overflow latch refuses every unknown resume
 * for the rest of the host's life, while the endpoint still allows new
 * native sessions.
 */
export class OpenCodeRetainedSessions {
  readonly #maxCatalogs: number;
  readonly #catalogTtlMs: number;
  readonly #now: () => number;
  #catalogs = new Map<
    string,
    { readonly tools: ReadonlyArray<ProviderToolDefinition>; readonly expiresAt: number }
  >();
  #stale = new Set<string>();
  #staleOverflow = false;

  constructor(
    options: {
      readonly maxCatalogs?: number;
      readonly catalogTtlMs?: number;
      readonly now?: () => number;
    } = {},
  ) {
    this.#maxCatalogs = options.maxCatalogs ?? MAX_REMEMBERED_CATALOGS;
    this.#catalogTtlMs = options.catalogTtlMs ?? REMEMBERED_CATALOG_MS;
    this.#now = options.now ?? Date.now;
  }

  /** The tools a resume may reuse, or undefined on a miss; a miss means none. */
  catalog(id: string): ReadonlyArray<ProviderToolDefinition> | undefined {
    this.#sweep();
    return this.#catalogs.get(id)?.tools;
  }

  /**
   * Remembers the session's tools for its next resume. Reinserting a known
   * id moves it newest-written; a full cache drops the entry oldest last
   * written first. An empty roster is not kept: it would mean the same
   * thing as a miss while evicting a real catalogue.
   */
  rememberCatalog(id: string, tools: ReadonlyArray<ProviderToolDefinition>): void {
    this.#sweep();
    this.#catalogs.delete(id);
    if (tools.length === 0) return;
    if (this.#catalogs.size >= this.#maxCatalogs) {
      const oldest = this.#catalogs.keys().next().value;
      if (oldest !== undefined) this.#catalogs.delete(oldest);
    }
    this.#catalogs.set(id, { tools, expiresAt: this.#now() + this.#catalogTtlMs });
  }

  /** Drops the cached catalogue only; the tombstone, if any, stays. */
  forgetCatalog(id: string): void {
    this.#catalogs.delete(id);
  }

  /**
   * The session can never be resumed safely again, so its catalogue goes too:
   * a resume that misses gets no tools, and the tombstone refuses it anyway.
   */
  markStale(id: string): void {
    this.#catalogs.delete(id);
    if (this.#stale.has(id)) return;
    if (this.#stale.size >= MAX_STALE_SESSIONS) {
      this.#staleOverflow = true;
      return;
    }
    this.#stale.add(id);
  }

  /** Refuses the id when it is tombstoned or a tombstone was lost to the cap. */
  refusesResume(id: string): boolean {
    return this.#staleOverflow || this.#stale.has(id);
  }

  /**
   * OpenCode itself reported the session deleted, so nothing of it may be
   * kept — catalogue and tombstone both go. The overflow latch stays: it
   * denies unknown ids, and this id is now simply unknown.
   */
  sessionRemoved(id: string): void {
    this.#catalogs.delete(id);
    this.#stale.delete(id);
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, entry] of this.#catalogs) {
      if (entry.expiresAt <= now) this.#catalogs.delete(id);
    }
  }
}

/**
 * The files an `always` answer remembered for one native process's lifetime.
 *
 * OpenCode saves an `always` grant in its own store and applies later
 * matching edits without asking, so each file such an answer names is
 * admitted by the file-change check for as long as this ledger lives — the
 * connection's running process, never a later one. A batch is taken whole or
 * not at all, so a full or retired ledger admits nothing new instead of
 * half a grant; `retire` drops every name so a late callback holding the old
 * ledger cannot re-add a grant the next process must not inherit.
 */
export class RememberedOpenCodeEdits {
  /**
   * Each admitted name owns one entry. `pending` counts the grants still
   * awaiting their RPC's outcome that reserved it; `saved` latches once any
   * one of them succeeded or the provider reported the file itself. A name
   * leaves only when no outstanding reservation still needs it and nothing
   * saved it — so one failed call cannot retract a file another grant kept.
   */
  readonly #files = new Map<string, { pending: number; saved: boolean }>();
  #retired = false;

  has(file: string): boolean {
    return this.#files.has(file);
  }

  /**
   * Reserves the whole batch ahead of its answer's RPC, or none of it when
   * it cannot fit. The names are visible to `has` at once — OpenCode may
   * stream the edit before acknowledging the answer — and the returned
   * closure settles them once: `saved` keeps every name it owns, `unsaved`
   * drops each name no other reservation still needs.
   */
  reserve(files: ReadonlyArray<string>): ((saved: boolean) => void) | undefined {
    if (this.#retired) return undefined;
    const names = new Set(files);
    let count = this.#files.size;
    for (const name of names) {
      if (!this.#files.has(name)) count += 1;
    }
    if (count > MAX_REMEMBERED_EDITS) return undefined;
    const reserved: Array<[string, { pending: number; saved: boolean }]> = [];
    for (const name of names) {
      let entry = this.#files.get(name);
      if (entry === undefined) {
        entry = { pending: 0, saved: false };
        this.#files.set(name, entry);
      }
      entry.pending += 1;
      reserved.push([name, entry]);
    }
    let settled = false;
    return (saved: boolean) => {
      if (settled) return;
      settled = true;
      for (const [name, entry] of reserved) {
        if (this.#files.get(name) !== entry) continue;
        entry.saved ||= saved;
        entry.pending -= 1;
        if (entry.pending === 0 && !entry.saved) this.#files.delete(name);
      }
    };
  }

  /**
   * Admits a batch the provider itself settled — it reported the file
   * without waiting on an answer's RPC — or refuses it whole when it cannot
   * fit.
   */
  add(files: ReadonlyArray<string>): boolean {
    const settle = this.reserve(files);
    if (settle === undefined) return false;
    settle(true);
    return true;
  }

  /** Ends the ledger with its process: every grant gone, nothing admitted. */
  retire(): void {
    this.#retired = true;
    this.#files.clear();
  }
}
