import {
  AggregateId,
  AggregateVersion,
  BROWSER_CAPTURE_AGGREGATE_TYPE,
  BROWSER_CAPTURE_KEPT,
  BROWSER_STEP_AGGREGATE_TYPE,
  BROWSER_STEP_RECORDED,
  decodeBrowserCapture,
  decodeBrowserCaptureId,
  decodeBrowserStep,
  CorrelationId,
  decodeEventActor,
  EventId,
  EventName,
  DEFAULT_BROWSER_CAPTURES_PER_THREAD,
  MAX_BROWSER_CAPTURE_BYTES,
  MAX_BROWSER_CAPTURES_PER_THREAD,
  MAX_BROWSER_RECORDING_BYTES,
  MAX_BROWSER_STEPS_PER_THREAD,
  UtcTimestamp,
  type BrowserCapture,
  type BrowserCaptureId,
  type BrowserCaptureOutcome,
  type BrowserRecordingFacts,
  type BrowserStep,
  type BrowserThreadId,
  type EventActor,
  type ProviderInstanceId,
  type StoredBrowserProfile,
} from "@octant/contracts";
import {
  browserCapturePageOrigin,
  browserCaptureRetention,
  browserRetainedCaptures,
  browserStepRecord,
  browserStepRetention,
  type BrowserStepFacts,
  type BrowserCaptureTaker,
} from "@octant/domain";
import { Schema } from "effect";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { Journal } from "../persistence/journal";
import { ConcurrencyConflict } from "../persistence/journalErrors";
import type { SqliteConnection } from "../persistence/sqlitePort";
import {
  BrowserCaptureInvalid,
  BrowserCaptureTooLarge,
  type BrowserCaptureStore,
} from "./browserCaptureStore";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);

const MAX_APPEND_ATTEMPTS = 3;
const SCREENSHOT_DATA_URL = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
/** A recording is always an animated PNG; the store still sniffs the bytes. */
const RECORDING_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;

export interface KeepBrowserCaptureInput {
  readonly threadId: BrowserThreadId;
  /** The screenshot as the browser runtime produced it. Never written to the journal. */
  readonly dataUrl: string;
  /**
   * Present when the picture is a recording: an animated PNG of the agent's
   * call, which keeps the recording's size bound rather than a screenshot's.
   */
  readonly recording?: BrowserRecordingFacts;
  readonly url: string | undefined;
  readonly title: string | undefined;
  readonly takenBy: BrowserCaptureTaker;
  /** The stored profile the page lived in, recorded with the capture. */
  readonly profile?: StoredBrowserProfile | undefined;
  /** The provider instance driving the tool; the journal actor for an agent capture. */
  readonly providerInstanceId: ProviderInstanceId;
  readonly correlationId: CorrelationId;
}

export interface RecordBrowserStepInput {
  readonly threadId: BrowserThreadId;
  readonly facts: BrowserStepFacts;
  /** The provider instance driving the tool; the journal actor for an agent step. */
  readonly providerInstanceId: ProviderInstanceId;
  readonly correlationId: CorrelationId;
}

export interface BrowserCaptureServiceOptions {
  readonly store: BrowserCaptureStore;
  readonly journal: Pick<Journal, "append" | "replayAggregate">;
  readonly connection: SqliteConnection;
  /** The journal actor for a capture the person took in the Browser pane. */
  readonly personActor: EventActor;
  readonly uuid: () => string;
  readonly clock: () => string;
  /**
   * The person's setting for how many captures a thread keeps, read at each
   * use. Absent, the default.
   */
  readonly capturesPerThread?: () => number;
}

/**
 * Thread-owned browser captures. The journal decides what exists: each kept
 * capture is one `browser.capture-kept@1` event on the thread's capture
 * aggregate, and the newest versions, as many as the person's setting keeps,
 * are the captures that survive. Removing the bytes of an older one is
 * cleanup that can be repeated, and `recover` finishes it after a crash.
 *
 * The setting can grow, and it grew from 32 to 200 by default. A larger
 * window reaches back to versions whose bytes were already removed under the
 * smaller one, so a capture is listed only while the store still holds its
 * bytes: growing the number never brings back a capture that was dropped.
 */
/** The most events `Journal.replayAggregate` hands back in one call. */
const REPLAY_PAGE = 1_000;

export class BrowserCaptureService {
  readonly #store: BrowserCaptureStore;
  readonly #journal: Pick<Journal, "append" | "replayAggregate">;
  readonly #connection: SqliteConnection;
  readonly #personActor: EventActor;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #capturesPerThread: () => number;
  /** The setting when recovery last swept every thread, and at each thread's last drop since. */
  readonly #keptAtStart: number;
  readonly #keptAtLastDrop = new Map<string, number>();
  /**
   * The highest version a sweep has passed over on each thread. Listing never
   * reaches below it, so a capture whose bytes could not yet be deleted is not
   * listed again when the person raises the number, and recovery removes it.
   */
  readonly #droppedThrough = new Map<string, number>();

  constructor(options: BrowserCaptureServiceOptions) {
    this.#store = options.store;
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#personActor = options.personActor;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
    this.#capturesPerThread = () =>
      Math.min(
        MAX_BROWSER_CAPTURES_PER_THREAD,
        Math.max(1, options.capturesPerThread?.() ?? DEFAULT_BROWSER_CAPTURES_PER_THREAD),
      );
    this.#keptAtStart = this.#capturesPerThread();
  }

  /**
   * Keep one screenshot. A refusal is a value, never a throw: the caller's
   * screenshot has already succeeded and must not fail because a copy could
   * not be kept.
   */
  async keep(input: KeepBrowserCaptureInput): Promise<BrowserCaptureOutcome> {
    const origin = browserCapturePageOrigin(input.url);
    if (origin === undefined || input.url === undefined) {
      return { status: "not-kept", reason: "no-page-origin" };
    }
    const encoded = (input.recording === undefined ? SCREENSHOT_DATA_URL : RECORDING_DATA_URL).exec(
      input.dataUrl,
    )?.[1];
    if (encoded === undefined) return { status: "not-kept", reason: "not-an-image" };
    const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
    if (
      bytes.length >
      (input.recording === undefined ? MAX_BROWSER_CAPTURE_BYTES : MAX_BROWSER_RECORDING_BYTES)
    ) {
      return { status: "not-kept", reason: "too-large" };
    }

    const captureId = decodeBrowserCaptureId(this.#uuid());
    let version: number;
    try {
      const staged = await this.#store.stage({ threadId: input.threadId, captureId, bytes });
      const finalized = await this.#store.finalize(staged);
      version = this.#append(
        decodeBrowserCapture({
          captureId,
          threadId: input.threadId,
          origin,
          url: input.url,
          ...(input.title === undefined ? {} : { title: input.title }),
          hash: finalized.hash,
          size: finalized.size,
          mime: finalized.mime,
          capturedAt: this.#clock(),
          ...(input.profile === undefined ? {} : { profile: input.profile }),
          ...(input.recording === undefined ? {} : { recording: input.recording }),
        }),
        input,
      );
    } catch (error) {
      await this.#store.remove(input.threadId, captureId).catch(() => undefined);
      if (error instanceof BrowserCaptureTooLarge) {
        return { status: "not-kept", reason: "too-large" };
      }
      if (error instanceof BrowserCaptureInvalid) {
        return { status: "not-kept", reason: "not-an-image" };
      }
      return { status: "not-kept", reason: "unavailable" };
    }
    // The capture is journaled from here on. Dropping the oldest one is
    // cleanup that recovery repeats, so a failure must not undo this capture.
    await this.#dropOlderThan(input.threadId, version).catch(() => undefined);
    if (input.recording !== undefined) {
      await this.#dropRecordingsPastCap(input.threadId).catch(() => undefined);
    }
    return {
      status: "kept",
      captureId,
      ...(input.recording === undefined ? {} : { recording: input.recording }),
    };
  }

  /**
   * Keep a capture carried here with a thread that moved from another of the
   * person's computers, under the moved thread. Moving is the person's act, so
   * the person is the journal actor. The profile the page lived in is left
   * out: it names a Browser profile on the other computer, and profiles never
   * move. A capture already kept under this id is left as it is, so a finish
   * asked again keeps nothing twice. Unlike `keep`, a failure throws: the move
   * must not arrive without a part it promised.
   */
  async carryMoved(input: {
    readonly threadId: BrowserThreadId;
    readonly captureId: BrowserCaptureId;
    readonly bytes: Uint8Array;
    readonly facts: Omit<BrowserCapture, "captureId" | "threadId" | "hash" | "size" | "mime">;
  }): Promise<void> {
    // Asked of the journal, not of the bytes: a capture already journaled
    // under this id is never journaled a second time.
    if (
      this.#journaledWindow(input.threadId).some((capture) => capture.captureId === input.captureId)
    ) {
      return;
    }
    const { profile: _otherComputers, ...facts } = input.facts;
    let version: number;
    try {
      // An earlier try that stopped before journaling may have left the file.
      await this.#store.remove(input.threadId, input.captureId).catch(() => undefined);
      const finalized = await this.#store.finalize(
        await this.#store.stage({
          threadId: input.threadId,
          captureId: input.captureId,
          bytes: input.bytes,
        }),
      );
      const capture = decodeBrowserCapture({
        ...facts,
        captureId: input.captureId,
        threadId: input.threadId,
        hash: finalized.hash,
        size: finalized.size,
        mime: finalized.mime,
      });
      version = this.#appendOne(
        BROWSER_CAPTURE_AGGREGATE_TYPE,
        BROWSER_CAPTURE_KEPT,
        capture,
        { actor: this.#personActor, correlationId: decodeCorrelationId(this.#uuid()) },
        capture.capturedAt,
      );
    } catch (error) {
      await this.#store.remove(input.threadId, input.captureId).catch(() => undefined);
      throw error;
    }
    await this.#dropOlderThan(input.threadId, version).catch(() => undefined);
    if (facts.recording !== undefined) {
      await this.#dropRecordingsPastCap(input.threadId).catch(() => undefined);
    }
  }

  /**
   * Record one step of the agent's Browser check. Best effort like keeping a
   * capture: a step that cannot be journaled never fails the action. Only
   * what `browserStepRecord` keeps reaches the journal; the request itself,
   * including anything typed, never gets here.
   */
  recordStep(input: RecordBrowserStepInput): void {
    try {
      const step = decodeBrowserStep({
        stepId: this.#uuid(),
        threadId: input.threadId,
        ...browserStepRecord(input.facts),
        recordedAt: this.#clock(),
      });
      this.#appendOne(BROWSER_STEP_AGGREGATE_TYPE, BROWSER_STEP_RECORDED, step, {
        actor: this.#actor(input),
        correlationId: input.correlationId,
      });
    } catch {
      // The proof is a convenience beside the action; losing a step is better
      // than failing a page the agent already acted on.
    }
  }

  /** The thread's retained steps, oldest first. */
  listSteps(threadId: BrowserThreadId): ReadonlyArray<BrowserStep> {
    const aggregateId = String(threadId);
    const head = readAggregateVersion(this.#connection, BROWSER_STEP_AGGREGATE_TYPE, aggregateId);
    if (head === 0) return [];
    const { firstRetainedVersion } = browserStepRetention(head);
    return this.#journal
      .replayAggregate({
        aggregateType: BROWSER_STEP_AGGREGATE_TYPE,
        aggregateId,
        afterVersion: firstRetainedVersion - 1,
        limit: MAX_BROWSER_STEPS_PER_THREAD,
      })
      .map((event) => decodeBrowserStep(event.payload));
  }

  /** The thread's retained captures, newest first. */
  list(threadId: BrowserThreadId): ReadonlyArray<BrowserCapture> {
    return browserRetainedCaptures(this.#window(threadId));
  }

  /**
   * Every capture in the thread's retained window whose bytes the store still
   * holds, recordings past the cap included.
   */
  #window(threadId: BrowserThreadId): ReadonlyArray<BrowserCapture> {
    const journaled = this.#journaledWindow(threadId);
    if (journaled.length === 0) return journaled;
    const held = this.#store.held(threadId);
    return journaled.filter((capture) => held.has(String(capture.captureId)));
  }

  /** The newest journaled captures, as many as the setting keeps, newest first. */
  #journaledWindow(threadId: BrowserThreadId): ReadonlyArray<BrowserCapture> {
    const aggregateId = String(threadId);
    const head = readAggregateVersion(
      this.#connection,
      BROWSER_CAPTURE_AGGREGATE_TYPE,
      aggregateId,
    );
    if (head === 0) return [];
    const limit = this.#capturesPerThread();
    const { firstRetainedVersion } = browserCaptureRetention(head, limit);
    const afterVersion = Math.max(
      firstRetainedVersion - 1,
      this.#droppedThrough.get(aggregateId) ?? 0,
    );
    if (afterVersion >= head) return [];
    return this.#journal
      .replayAggregate({
        aggregateType: BROWSER_CAPTURE_AGGREGATE_TYPE,
        aggregateId,
        afterVersion,
        limit,
      })
      .map((event) => decodeBrowserCapture(event.payload))
      .reverse();
  }

  /**
   * The bytes of one capture, only when it is a retained capture of this
   * thread. A capture id from another thread, or one already dropped, is
   * simply not found.
   */
  async read(
    threadId: BrowserThreadId,
    captureId: BrowserCaptureId,
  ): Promise<{ readonly capture: BrowserCapture; readonly bytes: Uint8Array } | undefined> {
    const capture = this.list(threadId).find((candidate) => candidate.captureId === captureId);
    if (capture === undefined) return undefined;
    try {
      const bytes = await this.#store.read({
        threadId,
        captureId,
        size: capture.size,
        hash: capture.hash,
        finalizedAt: capture.capturedAt,
      });
      return { capture, bytes };
    } catch {
      return undefined;
    }
  }

  /** Finishes byte removal for captures the journal no longer retains. */
  recover(): Promise<void> {
    return this.#store.recover((threadId, captureId) =>
      this.list(threadId).some((capture) => capture.captureId === captureId),
    );
  }

  #append(capture: BrowserCapture, input: KeepBrowserCaptureInput): number {
    return this.#appendOne(
      BROWSER_CAPTURE_AGGREGATE_TYPE,
      BROWSER_CAPTURE_KEPT,
      capture,
      { actor: this.#actor(input), correlationId: input.correlationId },
      capture.capturedAt,
    );
  }

  #appendOne(
    aggregateType: string,
    eventName: string,
    payload: BrowserCapture | BrowserStep,
    input: { readonly actor: EventActor; readonly correlationId: CorrelationId },
    occurredAt: string = "recordedAt" in payload ? payload.recordedAt : this.#clock(),
  ): number {
    const aggregateId = decodeAggregateId(String(payload.threadId));
    for (let attempt = 1; ; attempt += 1) {
      const expectedVersion = decodeAggregateVersion(
        readAggregateVersion(this.#connection, aggregateType, aggregateId),
      );
      try {
        this.#journal.append({
          aggregate: { aggregateType, aggregateId },
          expectedVersion,
          events: [
            {
              eventId: decodeEventId(this.#uuid()),
              eventName: decodeEventName(eventName),
              eventVersion: 1,
              correlationId: input.correlationId,
              actor: input.actor,
              occurredAt: decodeTimestamp(occurredAt),
              payload,
            },
          ],
        });
        return expectedVersion + 1;
      } catch (error) {
        if (!(error instanceof ConcurrencyConflict) || attempt >= MAX_APPEND_ATTEMPTS) throw error;
      }
    }
  }

  #actor(input: {
    readonly threadId: BrowserThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly takenBy?: BrowserCaptureTaker;
  }): EventActor {
    if (input.takenBy === "person") return this.#personActor;
    return decodeEventActor({
      kind: "agent",
      actorId: input.providerInstanceId,
      providerInstanceId: input.providerInstanceId,
      threadId: input.threadId,
    });
  }

  async #dropOlderThan(threadId: BrowserThreadId, headVersion: number): Promise<void> {
    const kept = this.#capturesPerThread();
    const droppedVersion = browserCaptureRetention(headVersion, kept).firstRetainedVersion - 1;
    const keptBefore = this.#keptAtLastDrop.get(String(threadId)) ?? this.#keptAtStart;
    let everyRemovalSucceeded = true;
    if (droppedVersion >= 1) {
      this.#droppedThrough.set(
        String(threadId),
        Math.max(this.#droppedThrough.get(String(threadId)) ?? 0, droppedVersion),
      );
      // The window normally advances by one capture a keep. After the person
      // lowers the number it jumps, and every version it passed over goes, or
      // raising the number again would list captures that were dropped.
      const firstDropped = kept < keptBefore ? 1 : droppedVersion;
      // The journal replays at most a thousand events a call, and a lowered
      // number on a long-lived thread passes over more than that.
      for (let after = firstDropped - 1; after < droppedVersion; after += REPLAY_PAGE) {
        const dropped = this.#journal.replayAggregate({
          aggregateType: BROWSER_CAPTURE_AGGREGATE_TYPE,
          aggregateId: String(threadId),
          afterVersion: after,
          limit: Math.min(REPLAY_PAGE, droppedVersion - after),
        });
        // A removal that fails here is not lost: listing no longer reaches the
        // capture, the next keep sweeps again, and recovery removes it.
        for (const event of dropped) {
          await this.#store
            .remove(threadId, decodeBrowserCapture(event.payload).captureId)
            .catch(() => {
              everyRemovalSucceeded = false;
            });
        }
      }
    }
    // Recorded only after a sweep that removed everything it passed over: a
    // sweep that threw, or a deletion that failed, keeps the higher number here,
    // so the next keep sweeps the passed-over versions again.
    if (everyRemovalSucceeded) this.#keptAtLastDrop.set(String(threadId), kept);
  }

  /**
   * Remove the bytes of the recordings the cap no longer retains: those in the
   * window past the newest eight. As with `#dropOlderThan`, the journal has
   * already stopped retaining them, so a removal that fails here is finished by
   * the next recovery pass, which asks `list`.
   */
  async #dropRecordingsPastCap(threadId: BrowserThreadId): Promise<void> {
    const retained = new Set(this.list(threadId).map((capture) => String(capture.captureId)));
    for (const capture of this.#window(threadId)) {
      if (retained.has(String(capture.captureId))) continue;
      await this.#store.remove(threadId, capture.captureId).catch(() => undefined);
    }
  }
}
