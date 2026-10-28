import { vi } from "vitest";

/**
 * An issuer or portal that stops answering: `hangs` never sends a status line,
 * and `stalls-mid-answer` sends a status and the start of a body that never
 * finishes. Only the request's own abort signal ends either, as with a
 * stalled connection; a request sent without one waits forever.
 */
export type StalledAnswer = "hangs" | "stalls-mid-answer";

const deadlines = new WeakMap<AbortSignal, AbortController>();

/**
 * Stand in for the issuer-request deadline, so a stalled request is abandoned
 * at once instead of after the real bound while every answered request keeps
 * its deadline unspent. Returns the bounds the broker asked for.
 */
export function controlIssuerDeadlines(): {
  readonly bounds: () => ReadonlyArray<number>;
  readonly restore: () => void;
} {
  const bounds: number[] = [];
  const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    bounds.push(ms);
    const deadline = new AbortController();
    deadlines.set(deadline.signal, deadline);
    return deadline.signal;
  });
  return { bounds: () => [...bounds], restore: () => spy.mockRestore() };
}

/** Answer a request the way a stalled issuer does; see {@link StalledAnswer}. */
export function stalledAnswer(
  kind: StalledAnswer,
  signal: AbortSignal | null | undefined,
  status = 200,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal === null || signal === undefined) return;
    if (kind === "hangs") {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    } else {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"'));
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));
    }
    // A deadline `controlIssuerDeadlines` issued passes now; any other
    // passes when its own bound does.
    queueMicrotask(() =>
      deadlines.get(signal)?.abort(new DOMException("The request timed out.", "TimeoutError")),
    );
  });
}
