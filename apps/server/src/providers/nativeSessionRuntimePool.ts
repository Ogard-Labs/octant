import type { ProviderInstanceId } from "@octant/contracts";

export interface RetainedNativeRuntime<T> {
  readonly value: T;
  readonly compatibility: string;
  readonly close: () => Promise<void>;
}

interface IdleRuntime {
  readonly instanceId: ProviderInstanceId;
  readonly identity: string;
  readonly resource: RetainedNativeRuntime<unknown>;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Holds only detached, successfully settled sessions; active turns stay with their lease. */
export class NativeSessionRuntimePool {
  readonly #idle = new Map<string, IdleRuntime>();
  readonly #closing = new Set<Promise<void>>();
  #closed = false;

  has(instanceId: ProviderInstanceId, identity: string): boolean {
    return this.#idle.has(JSON.stringify([instanceId, identity]));
  }

  async take<T>(
    instanceId: ProviderInstanceId,
    identity: string,
    compatibility: string,
  ): Promise<RetainedNativeRuntime<T> | undefined> {
    if (this.#closed) return undefined;
    const key = JSON.stringify([instanceId, identity]);
    const entry = this.#idle.get(key);
    if (entry === undefined) return undefined;
    this.#idle.delete(key);
    clearTimeout(entry.timer);
    if (entry.resource.compatibility !== compatibility) {
      await this.#close(entry.resource);
      return undefined;
    }
    return entry.resource as RetainedNativeRuntime<T>;
  }

  async retain<T>(
    instanceId: ProviderInstanceId,
    identity: string,
    resource: RetainedNativeRuntime<T>,
  ): Promise<void> {
    const key = JSON.stringify([instanceId, identity]);
    if (this.#closed || this.#idle.has(key)) {
      await this.#close(resource);
      return;
    }
    const entry: IdleRuntime = {
      instanceId,
      identity,
      resource,
      timer: setTimeout(() => {
        if (this.#idle.get(key) !== entry) return;
        this.#idle.delete(key);
        void this.#close(resource).catch(() => undefined);
      }, 30_000),
    };
    entry.timer.unref();
    this.#idle.set(key, entry);
    // Bound residency across all providers, not separately for every task.
    while (this.#idle.size > 4) {
      const oldest = this.#idle.entries().next().value;
      if (oldest === undefined) break;
      this.#idle.delete(oldest[0]);
      clearTimeout(oldest[1].timer);
      await this.#close(oldest[1].resource);
    }
  }

  async invalidate(instanceId: ProviderInstanceId): Promise<void> {
    const closes: Promise<void>[] = [];
    for (const [key, entry] of this.#idle) {
      if (entry.instanceId !== instanceId) continue;
      this.#idle.delete(key);
      clearTimeout(entry.timer);
      closes.push(this.#close(entry.resource));
    }
    await Promise.all(closes);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const [key, entry] of this.#idle) {
      this.#idle.delete(key);
      clearTimeout(entry.timer);
      void this.#close(entry.resource).catch(() => undefined);
    }
    await Promise.all([...this.#closing]);
  }

  #close(resource: RetainedNativeRuntime<unknown>): Promise<void> {
    const closing = Promise.resolve().then(() => resource.close());
    this.#closing.add(closing);
    void closing.then(
      () => this.#closing.delete(closing),
      () => undefined,
    );
    return closing;
  }
}
