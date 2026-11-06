/** One active turn owns this scheduler; it never polls and owns no persistent session. */
export class CodeTurnReviewCaptureScheduler {
  readonly #capture: (
    final: boolean,
    signal: AbortSignal,
    deadline: number,
  ) => Promise<void | "unavailable">;
  readonly #unavailable: (reason: "deadline" | "capture", current: () => boolean) => void;
  readonly #now: () => number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;
  #running: Promise<void> | undefined;
  #lastStarted = -Infinity;
  #dirty = false;
  #closed = false;
  #finishing = false;
  #attempt = 0;

  constructor(input: {
    readonly capture: (
      final: boolean,
      signal: AbortSignal,
      deadline: number,
    ) => Promise<void | "unavailable">;
    readonly unavailable: (reason: "deadline" | "capture", current: () => boolean) => void;
    readonly now: () => number;
  }) {
    this.#capture = input.capture;
    this.#unavailable = input.unavailable;
    this.#now = input.now;
  }

  request(): void {
    if (this.#closed || this.#finishing) return;
    this.#dirty = true;
    this.#schedule();
  }

  #schedule(): void {
    if (
      this.#timer !== undefined ||
      this.#running !== undefined ||
      this.#closed ||
      !this.#dirty ||
      this.#finishing
    )
      return;
    const delay = Math.max(500, this.#lastStarted + 5_000 - this.#now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, delay);
    this.#timer.unref?.();
  }

  async flush(final = false): Promise<void> {
    if (this.#closed) return;
    if (final) this.#finishing = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#running !== undefined) {
      if (!final) return this.#running;
      await this.#running;
    }
    if (this.#closed) return;
    this.#dirty = false;
    this.#lastStarted = this.#now();
    const running = this.#execute(final);
    this.#running = running;
    void running.finally(() => {
      if (this.#running === running) this.#running = undefined;
      this.#schedule();
    });
    return running;
  }

  async #execute(final: boolean): Promise<void> {
    const attempt = ++this.#attempt;
    const current = () => !this.#closed && this.#attempt === attempt;
    const controller = new AbortController();
    this.#controller = controller;
    let reported = false;
    const failed = (reason: "deadline" | "capture") => {
      if (reported || this.#closed || controller.signal.aborted) return;
      reported = true;
      try {
        this.#unavailable(reason, current);
      } catch {
        /* Evidence publication must not fail the running turn. */
      }
    };
    let removeAbort = () => {};
    const cancelled = new Promise<void>((resolve) => {
      const stop = () => resolve();
      controller.signal.addEventListener("abort", stop, { once: true });
      removeAbort = () => controller.signal.removeEventListener("abort", stop);
    });
    const expiresAt = this.#now() + 20_000;
    const expire = () => {
      failed("deadline");
      controller.abort();
    };
    const deadline = setTimeout(expire, 20_000);
    try {
      await Promise.race([
        Promise.resolve()
          .then(() => {
            if (this.#now() >= expiresAt) return expire();
            if (!this.#closed && !controller.signal.aborted)
              return this.#capture(final, controller.signal, expiresAt);
          })
          .then((result) => {
            if (result === "unavailable") failed("capture");
          })
          .catch(() => failed("capture")),
        cancelled,
      ]);
      if (this.#now() >= expiresAt) expire();
    } finally {
      clearTimeout(deadline);
      removeAbort();
      if (this.#controller === controller) this.#controller = undefined;
    }
  }

  cancelPending(): void {
    this.#attempt++;
    this.#dirty = false;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort();
  }

  close(): void {
    this.#closed = true;
    this.cancelPending();
  }
}
