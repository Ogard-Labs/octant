export class BoundedAsyncInput<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waitingConsumers: ((result: IteratorResult<T>) => void)[] = [];
  private readonly waitingProducers: {
    readonly value: T;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }[] = [];
  private closed = false;

  constructor(private readonly capacity: number) {}

  offer(value: T): Promise<void> {
    if (this.closed) return Promise.reject(new Error("closed"));
    const consumer = this.waitingConsumers.shift();
    if (consumer !== undefined) {
      consumer({ done: false, value });
      return Promise.resolve();
    }
    if (this.values.length < this.capacity) {
      this.values.push(value);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.waitingProducers.push({ value, resolve, reject });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const consume of this.waitingConsumers.splice(0)) {
      consume({ done: true, value: undefined });
    }
    for (const producer of this.waitingProducers.splice(0)) {
      producer.reject(new Error("closed"));
    }
  }

  clear(): readonly T[] {
    if (this.closed) return [];
    const cleared = this.values.splice(0);
    for (const producer of this.waitingProducers.splice(0)) {
      cleared.push(producer.value);
      producer.reject(new Error("cleared"));
    }
    return cleared;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.take(),
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }

  private take(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) {
      const producer = this.waitingProducers.shift();
      if (producer !== undefined) {
        this.values.push(producer.value);
        producer.resolve();
      }
      return Promise.resolve({ done: false, value });
    }
    const producer = this.waitingProducers.shift();
    if (producer !== undefined) {
      producer.resolve();
      return Promise.resolve({ done: false, value: producer.value });
    }
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waitingConsumers.push(resolve));
  }
}

export interface ClaudeCloseCoordinator {
  readonly closeOnce: () => Promise<void>;
  readonly closeWithRetry: () => Promise<void>;
}

export function makeClaudeCloseCoordinator(
  closeInput: () => void,
  closeSdk: () => void,
): ClaudeCloseCoordinator {
  let closed = false;
  let closing: Promise<void> | undefined;

  const closeOnce = (): Promise<void> => {
    closeInput();
    if (closed) return Promise.resolve();
    if (closing !== undefined) return closing;
    const attempt = Promise.resolve()
      .then(closeSdk)
      .then(() => {
        closed = true;
      })
      .finally(() => {
        if (closing === attempt) closing = undefined;
      });
    closing = attempt;
    return attempt;
  };

  const closeWithRetry = async (): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await closeOnce();
        return;
      } catch {
        // A second bounded attempt covers transient SDK close failures.
      }
    }
  };

  return { closeOnce, closeWithRetry };
}
