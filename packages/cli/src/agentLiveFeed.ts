import type { OctantMode } from "@octant/contracts";
import type { OpenedLocalControlSession } from "./localControl";

/**
 * "Something changed on this thread", as soon as the host says so.
 *
 * The terminal still reads the thread to draw it — the host's own view stays
 * the one truth — but it reads when the host has news instead of on a fixed
 * tick. Changes that arrive while a read is under way collapse into one
 * pending wake, so a burst of text never queues a burst of reads.
 */
export class AgentWake {
  #pending = false;
  #waiter: (() => void) | undefined;

  notify(): void {
    this.#pending = true;
    this.#waiter?.();
  }

  /**
   * Resolves at the next change, or after `fallbackMs` for what no stream
   * carries (harness approvals and questions), or when `signal` aborts.
   */
  next(fallbackMs: number, signal?: AbortSignal): Promise<void> {
    if (this.#pending || signal?.aborted === true) {
      this.#pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.#waiter = undefined;
        this.#pending = false;
        resolve();
      };
      const timer = setTimeout(done, fallbackMs);
      signal?.addEventListener("abort", done, { once: true });
      this.#waiter = done;
    });
  }
}

/** How long to wait before reopening a stream the host ended or refused. */
const REOPEN_MS = 250;
const MAX_BACKOFF_MS = 2_000;
/** A Code turn's events come as short replays; read again this soon after one that had news. */
const CODE_ACTIVE_MS = 50;
/** Conversation pages read per check; a longer backlog is finished on the next one. */
const MAX_CODE_PAGES = 8;

/**
 * Follows a thread's live stream for as long as `signal` is open and wakes
 * `wake` on every frame. Chat and Work are held-open streams; Code turns are
 * short replays of the running operation's events, read back to back. A
 * session that cannot stream leaves `wake` to its fallback timer.
 */
export function followAgentThread(
  session: OpenedLocalControlSession,
  mode: OctantMode,
  threadId: string,
  wake: AgentWake,
  signal: AbortSignal,
): void {
  if (session.stream === undefined) return;
  const follow = mode === "chat" ? followChat : mode === "work" ? followWork : followCode;
  void follow(session, threadId, wake, signal).catch(() => undefined);
}

async function followChat(
  session: OpenedLocalControlSession,
  threadId: string,
  wake: AgentWake,
  signal: AbortSignal,
): Promise<void> {
  const id = encodeURIComponent(threadId);
  const snapshot = async () => {
    const response = await session.send({ path: `/api/chat/threads/${id}`, method: "GET" });
    return numberField(response.body, "lastSequence");
  };
  let cursor = await snapshot();
  let backoff = REOPEN_MS;
  while (!signal.aborted) {
    if (cursor === undefined) {
      await pause(backoff, signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      cursor = await snapshot();
      continue;
    }
    const opened = await streamLines(
      session,
      `/api/chat/threads/${id}/events?afterSequence=${cursor}`,
      signal,
    );
    if (opened === undefined) {
      // A refused stream means the cursor or the thread moved; start again
      // from the host's current view.
      cursor = undefined;
      continue;
    }
    for await (const line of opened) {
      const sequence = numberField(parseLine(line), "sequence");
      if (sequence !== undefined && sequence > cursor) cursor = sequence;
      wake.notify();
    }
    backoff = REOPEN_MS;
    // The host ends a quiet chat stream after a few seconds; reopen at once.
    await pause(REOPEN_MS, signal);
  }
}

async function followWork(
  session: OpenedLocalControlSession,
  threadId: string,
  wake: AgentWake,
  signal: AbortSignal,
): Promise<void> {
  const id = encodeURIComponent(threadId);
  const snapshot = async () => {
    const response = await session.send({
      path: `/api/work/turns/transcript/${id}`,
      method: "GET",
    });
    return numberField(response.body, "liveCursor");
  };
  let cursor = await snapshot();
  let backoff = REOPEN_MS;
  while (!signal.aborted) {
    if (cursor === undefined) {
      await pause(backoff, signal);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      cursor = await snapshot();
      continue;
    }
    const opened = await streamLines(
      session,
      `/api/work/turns/stream/${id}?afterSequence=${cursor}`,
      signal,
    );
    if (opened === undefined) {
      cursor = undefined;
      continue;
    }
    for await (const line of opened) {
      const frame = parseLine(line);
      // The live feed restarts its numbering with the host, or drops a
      // cursor it no longer holds; either way the transcript is the new base.
      if (stringField(frame, "kind") === "snapshot-required") {
        cursor = await snapshot();
        wake.notify();
        break;
      }
      const sequence = numberField(frame, "sequence");
      if (sequence !== undefined && cursor !== undefined && sequence > cursor) cursor = sequence;
      wake.notify();
    }
    backoff = REOPEN_MS;
    await pause(REOPEN_MS, signal);
  }
}

async function followCode(
  session: OpenedLocalControlSession,
  threadId: string,
  wake: AgentWake,
  signal: AbortSignal,
): Promise<void> {
  const id = encodeURIComponent(threadId);
  const turns = { cursor: 0, latest: undefined as string | undefined };
  let operationId: string | undefined;
  let cursor = 0;
  while (!signal.aborted) {
    // The turn that is running now; a new message starts a new operation.
    const latest = await latestCodeOperation(session, id, turns);
    if (latest !== operationId) {
      operationId = latest;
      cursor = 0;
      if (latest !== undefined) wake.notify();
    }
    if (operationId === undefined) {
      await pause(REOPEN_MS, signal);
      continue;
    }
    const opened = await streamLines(
      session,
      `/api/code/threads/${id}/operations/${encodeURIComponent(operationId)}/events?afterCursor=${cursor}`,
      signal,
    );
    if (opened === undefined) {
      // A stale cursor replays the operation from its start.
      cursor = 0;
      await pause(REOPEN_MS, signal);
      continue;
    }
    let news = false;
    for await (const line of opened) {
      const next = numberField(parseLine(line), "cursor");
      if (next !== undefined && next > cursor) cursor = next;
      news = true;
    }
    if (news) wake.notify();
    await pause(news ? CODE_ACTIVE_MS : REOPEN_MS, signal);
  }
}

/**
 * The thread's newest turn. Pages only list turns that started after the
 * cursor, so following `nextCursor` from where the last read stopped reaches
 * the newest turn of a long thread without rereading the ones before it.
 */
async function latestCodeOperation(
  session: OpenedLocalControlSession,
  id: string,
  turns: { cursor: number; latest: string | undefined },
): Promise<string | undefined> {
  for (let page = 0; page < MAX_CODE_PAGES; page += 1) {
    const response = await session.send({
      path: `/api/code/threads/${id}/conversation?afterCursor=${turns.cursor}&limit=50`,
      method: "GET",
    });
    const listed = recordField(response.body, "turns");
    const next = numberField(response.body, "nextCursor");
    if (response.status !== 200 || !Array.isArray(listed) || next === undefined) break;
    const newest = stringField(listed.at(-1), "operationId");
    if (newest !== undefined) turns.latest = newest;
    if (next <= turns.cursor) break;
    turns.cursor = next;
    if (recordField(response.body, "hasMore") !== true) break;
  }
  return turns.latest;
}

async function streamLines(
  session: OpenedLocalControlSession,
  path: string,
  signal: AbortSignal,
): Promise<AsyncIterable<string> | undefined> {
  const opened = await session.stream?.(path, signal);
  return opened?.kind === "open" ? opened.lines : undefined;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function recordField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const field = recordField(value, key);
  return typeof field === "number" && Number.isSafeInteger(field) ? field : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = recordField(value, key);
  return typeof field === "string" ? field : undefined;
}
