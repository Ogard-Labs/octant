import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeSideChatSidecar,
  SideChatSidecar,
  type ChatThreadId,
  type MentionableThreadId,
} from "@octant/contracts";
import { Schema } from "effect";

const SIDECAR_DIR = "side-chat";
const SIDECAR_FILE = "sidecars.json";
const SIDECAR_TEMP_FILE = "sidecars.json.tmp";

/**
 * One persisted row: the wire link plus the one fact only the registry knows.
 *
 * `pendingInheritance` marks a claim the admission has not finished — Chat may
 * not hold the thread it names, and if it does, that thread may not carry the
 * source thread's provider/model yet. It is written only while the claim is
 * unfinished, so a settled registry is byte-identical to the wire shape.
 */
const StoredSideChatSidecar = Schema.Struct({
  ...SideChatSidecar.fields,
  pendingInheritance: Schema.optional(Schema.Literal(true)),
}).annotations({ parseOptions: { onExcessProperty: "error" as const } });
const decodeStoredSideChatSidecar = Schema.decodeUnknownSync(StoredSideChatSidecar);

interface RegisteredSidecar {
  readonly link: SideChatSidecar;
  /** True while the claim has not been proven finished in Chat. */
  readonly pendingInheritance: boolean;
}

/**
 * Persisted Side Chat sidecar registry.
 *
 * The registry is the authority for two facts the renderer must never decide:
 * which source thread owns which sidecar, and which Chat threads are hidden
 * sidecars. Chat's own bootstrap consults {@link SideChatSidecarStore.hiddenThreadIds}
 * so a sidecar never appears in Recents, Unfiled, or Project nesting — hiding
 * it in the browser instead would leave the thread listable by any other
 * client of the same host.
 *
 * It is deliberately a small append/replace JSON file rather than a new event
 * aggregate: a sidecar is a link between two existing threads, and inventing a
 * third journalled aggregate for it would add a replay surface with no
 * transitions worth replaying.
 */
export class SideChatSidecarStore {
  readonly #root: string;
  readonly #file: string;
  readonly #tempFile: string;
  #bySource = new Map<string, RegisteredSidecar>();
  #loaded = false;
  #unreadable = false;
  #writing: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#root = join(dataDirectory, SIDECAR_DIR);
    this.#file = join(this.#root, SIDECAR_FILE);
    this.#tempFile = join(this.#root, SIDECAR_TEMP_FILE);
  }

  /**
   * Load the registry from disk once, distinguishing a file that is absent
   * from one that is present but unreadable.
   *
   * Absent means a host that has never opened a Side Chat: empty is the truth.
   * Present-but-unreadable means the opposite — links exist and this file is
   * the only record of them, because a sidecar is a JSON link rather than a
   * journalled aggregate, so nothing can rebuild it. Reading that as "no
   * sidecars" would return every sidecar thread to Recents *and* let the next
   * open mint a duplicate whose write flushes the damaged file away with it.
   * So the registry freezes instead: it serves the rows that did decode and
   * refuses every write until the file is repaired or removed, which keeps
   * Side Chat unavailable rather than destructive. Hydration still resolves,
   * because failing it would take the whole Chat surface down with it.
   *
   * What freezing cannot recover is a link whose row did not decode at all:
   * its sidecar thread id is unreadable, so that thread is listed as an
   * ordinary Chat thread until the file is repaired. Nothing else records the
   * link — this is the honest limit of a registry that is not journalled, not
   * a reason to guess a source thread from a sidecar's title.
   */
  async hydrate(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (error) {
      // Only "no file can be there" proves absence. A read the host refused
      // for any other reason says nothing about what the file holds, so it
      // fails closed rather than reporting an empty registry.
      const code = (error as NodeJS.ErrnoException).code;
      this.#unreadable = code !== "ENOENT" && code !== "ENOTDIR";
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#unreadable = true;
      return;
    }
    if (!Array.isArray(parsed)) {
      this.#unreadable = true;
      return;
    }
    const next = new Map<string, RegisteredSidecar>();
    for (const entry of parsed) {
      try {
        const { pendingInheritance, ...link } = decodeStoredSideChatSidecar(entry);
        next.set(String(link.sourceThreadId), {
          link,
          pendingInheritance: pendingInheritance === true,
        });
      } catch {
        // A row that cannot be decoded is a link this registry can no longer
        // name, so the whole file is treated as damaged: the rows that did
        // decode stay usable, and nothing is written over the rest.
        this.#unreadable = true;
      }
    }
    this.#bySource = next;
  }

  /**
   * The one usable sidecar for a source thread. A claim whose admission never
   * finished is not one: it may name a thread Chat never created, or one that
   * never received the source thread's provider/model.
   */
  find(sourceThreadId: MentionableThreadId): SideChatSidecar | undefined {
    const registered = this.#bySource.get(String(sourceThreadId));
    return registered === undefined || registered.pendingInheritance ? undefined : registered.link;
  }

  /**
   * The sidecar link a Chat thread id belongs to, when that thread is itself a
   * usable sidecar. Chat's send path asks this way round: it holds the thread
   * being sent to and needs the source thread that lane is about. An
   * unfinished claim answers nothing here, so a turn on the thread it named
   * can never carry the source transcript to a selection the user did not
   * choose for that source.
   */
  findBySidecarThread(sidecarThreadId: ChatThreadId): SideChatSidecar | undefined {
    const registered = this.#registeredBySidecarThread(sidecarThreadId);
    return registered === undefined || registered.pendingInheritance ? undefined : registered.link;
  }

  /**
   * Chat thread ids that are hidden sidecars. Chat's bootstrap and search
   * filter against this set so a sidecar is unlisted everywhere at once.
   * Unfinished claims count: the thread they named may already exist, and it
   * is a sidecar rather than an ordinary Recent.
   */
  hiddenThreadIds(): ReadonlySet<string> {
    const hidden = new Set<string>();
    for (const registered of this.#bySource.values()) {
      hidden.add(String(registered.link.sidecarThreadId));
    }
    return hidden;
  }

  /** Every recorded sidecar, newest link first. */
  list(): ReadonlyArray<SideChatSidecar> {
    return this.#registered().map((registered) => registered.link);
  }

  /**
   * Whether a recorded claim still has to be finished in Chat. An unrecorded
   * source thread is not pending — it has no claim at all.
   */
  inheritancePending(sourceThreadId: MentionableThreadId): boolean {
    return this.#bySource.get(String(sourceThreadId))?.pendingInheritance === true;
  }

  /**
   * Record the sidecar claim for a source thread. Returns the sidecar that is
   * now authoritative: an existing link wins, so a racing second open reuses
   * the first sidecar instead of stranding a duplicate Chat thread.
   *
   * A new claim is written unfinished. Only {@link confirmInheritance} makes
   * it usable, so a crash, a restart, or a failed provider handoff leaves a
   * claimed-but-unusable link rather than a sidecar the caller believes is
   * complete.
   */
  async record(sidecar: SideChatSidecar): Promise<SideChatSidecar> {
    await this.hydrate();
    const existing = this.#bySource.get(String(sidecar.sourceThreadId));
    if (existing !== undefined) return existing.link;
    const link = decodeSideChatSidecar(sidecar);
    await this.#commit((current) => {
      const next = new Map(current);
      next.set(String(sidecar.sourceThreadId), { link, pendingInheritance: true });
      return next;
    });
    return sidecar;
  }

  /**
   * Mark a claim finished: Chat holds the thread it names, carrying the
   * selection it had to inherit. Idempotent, and a no-op for a link this
   * registry does not hold.
   */
  async confirmInheritance(sourceThreadId: MentionableThreadId): Promise<void> {
    await this.hydrate();
    const existing = this.#bySource.get(String(sourceThreadId));
    if (existing === undefined || !existing.pendingInheritance) return;
    await this.#commit((current) => {
      const next = new Map(current);
      next.set(String(sourceThreadId), { link: existing.link, pendingInheritance: false });
      return next;
    });
  }

  /** Forget a sidecar link, e.g. once its sidecar thread is deleted. */
  async forget(sourceThreadId: MentionableThreadId): Promise<void> {
    await this.hydrate();
    if (!this.#bySource.has(String(sourceThreadId))) {
      // Nothing to remove is only true of a registry that could be read.
      this.#assertReadable();
      return;
    }
    await this.#commit((current) => {
      const next = new Map(current);
      next.delete(String(sourceThreadId));
      return next;
    });
  }

  /** Forget the link that points at a sidecar Chat thread id. */
  async forgetSidecarThread(sidecarThreadId: ChatThreadId): Promise<void> {
    await this.hydrate();
    // Unfinished claims included: the thread Chat committed for one is still
    // the thread this link names, so deleting it must clear the claim too.
    const match = this.#registeredBySidecarThread(sidecarThreadId);
    if (match === undefined) {
      this.#assertReadable();
      return;
    }
    await this.forget(match.link.sourceThreadId);
  }

  #registered(): ReadonlyArray<RegisteredSidecar> {
    return [...this.#bySource.values()].sort((left, right) =>
      left.link.createdAt === right.link.createdAt
        ? String(left.link.sourceThreadId).localeCompare(String(right.link.sourceThreadId))
        : left.link.createdAt < right.link.createdAt
          ? 1
          : -1,
    );
  }

  #registeredBySidecarThread(sidecarThreadId: ChatThreadId): RegisteredSidecar | undefined {
    return [...this.#bySource.values()].find(
      (registered) => String(registered.link.sidecarThreadId) === String(sidecarThreadId),
    );
  }

  /**
   * Refuse anything that would write over, or answer from, a registry whose
   * contents are only partly known.
   */
  #assertReadable(): void {
    if (!this.#unreadable) return;
    throw new Error("The Side Chat sidecar registry is unreadable.");
  }

  /**
   * Queue one change behind every earlier one. Two admissions for *different*
   * source threads are not serialized by the caller's per-source admission
   * lock, so without this they would write the same temporary file and race to
   * rename it: one rename fails, and the surviving file can be a snapshot
   * taken before the other link existed — silently unhiding a committed
   * sidecar, which then reappears in Recents on the next boot.
   *
   * A failed write is reported to its own caller but must not poison the queue
   * for the next admission, so the chain itself always continues.
   */
  #commit(
    mutate: (current: Map<string, RegisteredSidecar>) => Map<string, RegisteredSidecar>,
  ): Promise<void> {
    // A registry that could not be read in full is frozen: its damaged file is
    // the only record of the links it could not name, and a write would
    // replace that file with a snapshot missing every one of them.
    try {
      this.#assertReadable();
    } catch (error) {
      return Promise.reject(error);
    }
    const committed = this.#writing.then(
      () => this.#applyAndWrite(mutate),
      () => this.#applyAndWrite(mutate),
    );
    this.#writing = committed.then(
      () => undefined,
      () => undefined,
    );
    return committed;
  }

  /**
   * The in-memory registry is the authority Chat reads, so it may only gain a
   * change the file already holds: an admission whose write failed and stayed
   * in memory would answer the caller's retry from memory without ever writing
   * again, and its sidecar thread would come back as an ordinary Recent.
   *
   * Applying and reverting inside the serialized section is what keeps a
   * rollback from corrupting a neighbour: the next queued change both mutates
   * and snapshots after this one has fully undone itself, so it can neither
   * lose its own link nor republish a rolled-back one.
   */
  async #applyAndWrite(
    mutate: (current: Map<string, RegisteredSidecar>) => Map<string, RegisteredSidecar>,
  ): Promise<void> {
    const previous = this.#bySource;
    this.#bySource = mutate(previous);
    try {
      await this.#write();
    } catch (error) {
      this.#bySource = previous;
      throw error;
    }
  }

  async #write(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    // Snapshot inside the queue, never before it: a payload captured while an
    // earlier write was still in flight would be missing that write's link.
    const payload = JSON.stringify(
      this.#registered().map((registered) =>
        registered.pendingInheritance
          ? { ...registered.link, pendingInheritance: true }
          : registered.link,
      ),
      null,
      2,
    );
    // Write-then-rename so a crash mid-write cannot leave a half-written
    // registry that would silently unhide every sidecar on the next boot.
    await writeFile(this.#tempFile, payload, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(this.#tempFile, this.#file);
    } catch (error) {
      await rm(this.#tempFile, { force: true });
      throw error;
    }
  }
}
