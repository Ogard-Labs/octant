import type { MobileRemoteTransport, MobileSendResult } from "@octant/client-runtime";
import {
  addWaiting,
  dropHostsNotIn,
  dueMessages,
  EMPTY_OUTBOX,
  markAttempted,
  markRefused,
  parseOutbox,
  removeWaiting,
  tryAgain,
  type Outbox,
  type Pairing,
  type WaitingMessage,
} from "./outbox";

/** A computer whose session is ready, and the pairing that made it so. */
export interface OutboxTarget {
  readonly hostId: string;
  readonly pairing: Pairing;
  readonly transport: MobileRemoteTransport;
}

export interface OutboxPorts {
  readonly load: () => Promise<string | null>;
  readonly keep: (text: string | undefined) => Promise<void>;
  readonly send: (input: {
    readonly transport: MobileRemoteTransport;
    readonly message: WaitingMessage;
    readonly stillWanted: () => boolean;
  }) => Promise<MobileSendResult>;
  /** Why a message is held for the person, in words. */
  readonly reasons: Readonly<Record<"tooOld" | "otherComputer" | "pairedAgain", string>>;
  readonly now: () => Date;
}

export interface OutboxSnapshot {
  readonly outbox: Outbox;
  /** The last change could not be kept, so it is lost if the app closes. */
  readonly unsaved: boolean;
}

// A computer that is there but does not answer is asked again after this.
const ASK_AGAIN_MS = 15_000;
const READ_AGAIN_MS = 5_000;

/**
 * The messages that wait, for as long as the app runs. One object outlives the
 * screens, which the app closes whenever it leaves the front: a send that was
 * under way then comes back to the state as it is, never to a copy of its own.
 */
export class OutboxStore {
  readonly #ports: OutboxPorts;
  #snapshot: OutboxSnapshot = { outbox: EMPTY_OUTBOX, unsaved: false };
  #loaded = false;
  #loading = false;
  #targets: ReadonlyArray<OutboxTarget> = [];
  #onSent: () => void = () => undefined;
  // Counts the times the app came to the front with its lock open. A send
  // belongs to one of them and is not started for an earlier one.
  #generation = 0;
  #attached = false;
  #pumping: number | undefined;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(ports: OutboxPorts) {
    this.#ports = ports;
  }

  readonly read = (): OutboxSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The app is open and these computers are ready; the answer closes it again. */
  attach(): () => void {
    this.#generation += 1;
    this.#attached = true;
    const generation = this.#generation;
    void this.#load();
    return () => {
      if (this.#generation !== generation) return;
      this.#generation += 1;
      this.#attached = false;
      this.#targets = [];
      clearTimeout(this.#timer);
    };
  }

  setTargets(targets: ReadonlyArray<OutboxTarget>, onSent: () => void): void {
    this.#targets = targets;
    this.#onSent = onSent;
    void this.#pump();
  }

  /** Keeps a message for its computer, or says why it cannot. */
  keep(message: WaitingMessage): "added" | "full" | "too-long" | "empty" {
    const result = addWaiting(this.#snapshot.outbox, message);
    if (result.status === "added") void this.#change(() => result.outbox).then(() => this.#pump());
    return result.status;
  }

  remove(id: string): void {
    void this.#change((outbox) => removeWaiting(outbox, id)).then(() => this.#pump());
  }

  tryAgain(id: string, pairing: Pairing | undefined): void {
    void this.#change((outbox) => tryAgain(outbox, id, this.#ports.now(), pairing)).then(() =>
      this.#pump(),
    );
  }

  /** Only a list of computers that was read whole; it says which are left. */
  keepHosts(hostIds: ReadonlySet<string>): void {
    if (!this.#loaded) return;
    if (dropHostsNotIn(this.#snapshot.outbox, hostIds) !== this.#snapshot.outbox)
      void this.#change((outbox) => dropHostsNotIn(outbox, hostIds));
  }

  #publish(snapshot: OutboxSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  /** Whether the change was kept. Nothing is written over what was not yet read. */
  async #change(next: (outbox: Outbox) => Outbox): Promise<boolean> {
    const outbox = next(this.#snapshot.outbox);
    if (outbox !== this.#snapshot.outbox) this.#publish({ ...this.#snapshot, outbox });
    if (!this.#loaded) {
      // Nothing is kept until the phone's list is read, so a change made
      // before then is unsaved until the read lets it be written.
      if (outbox.messages.length > 0 && !this.#snapshot.unsaved)
        this.#publish({ ...this.#snapshot, unsaved: true });
      return false;
    }
    try {
      await this.#ports.keep(outbox.messages.length === 0 ? undefined : JSON.stringify(outbox));
      if (this.#snapshot.unsaved) this.#publish({ ...this.#snapshot, unsaved: false });
      return true;
    } catch {
      if (!this.#snapshot.unsaved) this.#publish({ ...this.#snapshot, unsaved: true });
      return false;
    }
  }

  async #load(): Promise<void> {
    if (this.#loaded || this.#loading) {
      void this.#pump();
      return;
    }
    this.#loading = true;
    try {
      const kept = parseOutbox(await this.#ports.load());
      this.#loaded = true;
      await this.#change((outbox) => ({ messages: [...kept.messages, ...outbox.messages] }));
      void this.#pump();
    } catch {
      // Not read is not empty: it is read again, and not written over.
      this.#later(() => void this.#load(), READ_AGAIN_MS);
    } finally {
      this.#loading = false;
    }
  }

  #later(act: () => void, after: number): void {
    const generation = this.#generation;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (this.#generation === generation) act();
    }, after);
  }

  async #pump(): Promise<void> {
    const generation = this.#generation;
    if (!this.#attached || !this.#loaded) return;
    if (this.#pumping === generation) {
      // Something changed while it ran, which it may already have passed.
      this.#again = true;
      return;
    }
    this.#pumping = generation;
    this.#again = false;
    let unreached = false;
    const tried = new Set<string>();
    try {
      for (;;) {
        const next = this.#next(tried);
        if (next === undefined) return;
        tried.add(next.message.id);
        // Marked and kept before it leaves: a message on its way, or one a crash
        // cut off, is not offered for editing into a second one.
        const marked = await this.#change((outbox) => markAttempted(outbox, next.message.id));
        const stillWanted = () =>
          this.#generation === generation &&
          this.#snapshot.outbox.messages.some((entry) => entry.id === next.message.id);
        if (!stillWanted()) {
          if (this.#generation !== generation) return;
          continue;
        }
        const result = marked
          ? await this.#ports
              .send({ transport: next.target.transport, message: next.message, stillWanted })
              .catch((): MobileSendResult => ({ status: "unreachable" }))
          : ({ status: "unreachable" } as const);
        // What the computer said is true however long the app was away.
        if (result.status === "queued") {
          await this.#change((outbox) => removeWaiting(outbox, next.message.id));
          this.#onSent();
        } else if (result.status === "refused") {
          await this.#change((outbox) => markRefused(outbox, next.message.id, result.message));
        } else if (result.status === "unreachable") {
          unreached = true;
        }
        if (this.#generation !== generation) return;
      }
    } finally {
      if (this.#pumping === generation) {
        this.#pumping = undefined;
        if (this.#again) void this.#pump();
        else if (unreached) this.#later(() => void this.#pump(), ASK_AGAIN_MS);
      }
    }
  }

  #next(
    tried: ReadonlySet<string>,
  ): { readonly target: OutboxTarget; readonly message: WaitingMessage } | undefined {
    for (const target of this.#targets) {
      const { held, send } = dueMessages(this.#snapshot.outbox, target, this.#ports.now());
      for (const { message, why } of held)
        void this.#change((outbox) => markRefused(outbox, message.id, this.#ports.reasons[why]));
      const message = send.find((entry) => !tried.has(entry.id));
      if (message !== undefined) return { target, message };
    }
    return undefined;
  }
}
