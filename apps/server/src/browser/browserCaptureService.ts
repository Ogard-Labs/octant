import {
  AggregateId,
  AggregateVersion,
  BROWSER_CAPTURE_AGGREGATE_TYPE,
  BROWSER_CAPTURE_KEPT,
  decodeBrowserCapture,
  decodeBrowserCaptureId,
  decodeEventActor,
  EventId,
  EventName,
  MAX_BROWSER_CAPTURE_BYTES,
  MAX_BROWSER_CAPTURES_PER_THREAD,
  UtcTimestamp,
  type BrowserCapture,
  type BrowserCaptureId,
  type BrowserCaptureOutcome,
  type BrowserThreadId,
  type CorrelationId,
  type EventActor,
  type ProviderInstanceId,
} from "@octant/contracts";
import {
  browserCapturePageOrigin,
  browserCaptureRetention,
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

const MAX_APPEND_ATTEMPTS = 3;
const SCREENSHOT_DATA_URL = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

export interface KeepBrowserCaptureInput {
  readonly threadId: BrowserThreadId;
  /** The screenshot as the browser runtime produced it. Never written to the journal. */
  readonly dataUrl: string;
  readonly url: string | undefined;
  readonly title: string | undefined;
  readonly takenBy: BrowserCaptureTaker;
  /** The provider instance driving the tool; the journal actor for an agent capture. */
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
}

/**
 * Thread-owned browser captures. The journal decides what exists: each kept
 * capture is one `browser.capture-kept@1` event on the thread's capture
 * aggregate, and the newest `MAX_BROWSER_CAPTURES_PER_THREAD` versions are the
 * captures that survive. Removing the bytes of an older one is cleanup that
 * can be repeated, and `recover` finishes it after a crash.
 */
export class BrowserCaptureService {
  readonly #store: BrowserCaptureStore;
  readonly #journal: Pick<Journal, "append" | "replayAggregate">;
  readonly #connection: SqliteConnection;
  readonly #personActor: EventActor;
  readonly #uuid: () => string;
  readonly #clock: () => string;

  constructor(options: BrowserCaptureServiceOptions) {
    this.#store = options.store;
    this.#journal = options.journal;
    this.#connection = options.connection;
    this.#personActor = options.personActor;
    this.#uuid = options.uuid;
    this.#clock = options.clock;
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
    const encoded = SCREENSHOT_DATA_URL.exec(input.dataUrl)?.[1];
    if (encoded === undefined) return { status: "not-kept", reason: "not-an-image" };
    const bytes = Uint8Array.from(Buffer.from(encoded, "base64"));
    if (bytes.length > MAX_BROWSER_CAPTURE_BYTES) {
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
    return { status: "kept", captureId };
  }

  /** The thread's retained captures, newest first. */
  list(threadId: BrowserThreadId): ReadonlyArray<BrowserCapture> {
    const aggregateId = String(threadId);
    const head = readAggregateVersion(
      this.#connection,
      BROWSER_CAPTURE_AGGREGATE_TYPE,
      aggregateId,
    );
    if (head === 0) return [];
    const { firstRetainedVersion } = browserCaptureRetention(head);
    return this.#journal
      .replayAggregate({
        aggregateType: BROWSER_CAPTURE_AGGREGATE_TYPE,
        aggregateId,
        afterVersion: firstRetainedVersion - 1,
        limit: MAX_BROWSER_CAPTURES_PER_THREAD,
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
    const aggregateId = decodeAggregateId(String(capture.threadId));
    for (let attempt = 1; ; attempt += 1) {
      const expectedVersion = decodeAggregateVersion(
        readAggregateVersion(this.#connection, BROWSER_CAPTURE_AGGREGATE_TYPE, aggregateId),
      );
      try {
        this.#journal.append({
          aggregate: { aggregateType: BROWSER_CAPTURE_AGGREGATE_TYPE, aggregateId },
          expectedVersion,
          events: [
            {
              eventId: decodeEventId(this.#uuid()),
              eventName: decodeEventName(BROWSER_CAPTURE_KEPT),
              eventVersion: 1,
              correlationId: input.correlationId,
              actor: this.#actor(input),
              occurredAt: decodeTimestamp(capture.capturedAt),
              payload: capture,
            },
          ],
        });
        return expectedVersion + 1;
      } catch (error) {
        if (!(error instanceof ConcurrencyConflict) || attempt >= MAX_APPEND_ATTEMPTS) throw error;
      }
    }
  }

  #actor(input: KeepBrowserCaptureInput): EventActor {
    if (input.takenBy === "person") return this.#personActor;
    return decodeEventActor({
      kind: "agent",
      actorId: input.providerInstanceId,
      providerInstanceId: input.providerInstanceId,
      threadId: input.threadId,
    });
  }

  async #dropOlderThan(threadId: BrowserThreadId, headVersion: number): Promise<void> {
    const droppedVersion = browserCaptureRetention(headVersion).firstRetainedVersion - 1;
    if (droppedVersion < 1) return;
    const [dropped] = this.#journal.replayAggregate({
      aggregateType: BROWSER_CAPTURE_AGGREGATE_TYPE,
      aggregateId: String(threadId),
      afterVersion: droppedVersion - 1,
      limit: 1,
    });
    if (dropped === undefined) return;
    // A removal that fails here is not lost: the journal already no longer
    // retains the capture, so the next recovery pass removes it.
    await this.#store
      .remove(threadId, decodeBrowserCapture(dropped.payload).captureId)
      .catch(() => undefined);
  }
}
