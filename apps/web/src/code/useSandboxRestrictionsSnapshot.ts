import { useMemo, useSyncExternalStore } from "react";
import type { SandboxRestrictionsClient } from "@octant/client-runtime/sandbox-restrictions-client";
import type {
  SandboxRestrictionsScope,
  SandboxRestrictionsSnapshot,
} from "@octant/contracts/sandbox-policy";
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";

export function sandboxRestrictionsScopeKey(scope: SandboxRestrictionsScope): string {
  switch (scope.kind) {
    case "settings":
      return `settings:${scope.mode}`;
    case "project":
      return `project:${scope.projectId}`;
    case "session":
      return `session:${scope.threadId}`;
  }
}

interface SnapshotState {
  readonly snapshot: SandboxRestrictionsSnapshot | undefined;
  readonly failed: boolean;
}

const empty: SnapshotState = { snapshot: undefined, failed: false };
const readEmpty = () => empty;
const noop = () => {};
const entries = new WeakMap<SandboxRestrictionsClient, Map<string, ScopeSnapshot>>();

class ScopeSnapshot {
  state = empty;
  #listeners = new Set<() => void>();
  #stop: (() => void) | undefined;
  #pending: AbortController | undefined;
  #readAgain = false;
  #publication = 0;

  constructor(
    private readonly client: SandboxRestrictionsClient,
    private readonly scope: SandboxRestrictionsScope,
    private readonly retire: () => void,
  ) {}

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      this.#stop = scheduleVisibleInterval(this.refresh, 3000, { runImmediately: true });
    }
    return () => {
      if (!this.#listeners.delete(listener) || this.#listeners.size !== 0) return;
      this.#stop?.();
      this.#stop = undefined;
      this.state = empty;
      this.#pending?.abort();
      if (this.#pending === undefined) this.retire();
    };
  }

  refresh = (afterPending = false): void => {
    if (this.#listeners.size === 0 || !documentIsVisible()) return;
    if (this.#pending !== undefined) {
      if (afterPending || this.#pending.signal.aborted) this.#readAgain = true;
      return;
    }
    const pending = new AbortController();
    const publication = this.#publication;
    this.#pending = pending;
    void this.#read(pending, publication);
  };

  publish(snapshot: SandboxRestrictionsSnapshot): void {
    const current = this.state.snapshot;
    if (this.#listeners.size === 0 || (current !== undefined && current.version > snapshot.version))
      return;
    this.#publication++;
    this.#update({ snapshot, failed: false });
  }

  async #read(pending: AbortController, publication: number): Promise<void> {
    try {
      const snapshot = await this.client.settings(this.scope, pending.signal);
      if (!pending.signal.aborted && publication === this.#publication) {
        this.#update({ snapshot, failed: false });
      }
    } catch {
      if (
        !pending.signal.aborted &&
        publication === this.#publication &&
        this.state.snapshot === undefined &&
        !this.state.failed
      ) {
        this.#update({ snapshot: undefined, failed: true });
      }
    } finally {
      this.#pending = undefined;
      const readAgain = this.#readAgain;
      this.#readAgain = false;
      if (this.#listeners.size === 0) this.retire();
      else if (readAgain) this.refresh();
    }
  }

  #update(state: SnapshotState): void {
    this.state = state;
    for (const listener of this.#listeners) listener();
  }
}

export function publishSandboxRestrictionsSnapshot(
  client: SandboxRestrictionsClient,
  snapshot: SandboxRestrictionsSnapshot,
): void {
  entries.get(client)?.get(sandboxRestrictionsScopeKey(snapshot.scope))?.publish(snapshot);
}

export function useSandboxRestrictionsSnapshot(
  client: SandboxRestrictionsClient | undefined,
  scope: SandboxRestrictionsScope | undefined,
): SnapshotState & { readonly refresh: () => void } {
  const key = scope === undefined ? undefined : sandboxRestrictionsScopeKey(scope);
  // The key contains all scope fields; callers need not memoize their scope objects.
  const access = useMemo(() => {
    if (client === undefined || scope === undefined || key === undefined) {
      return { read: readEmpty, subscribe: () => noop, refresh: noop };
    }
    const lookup = () => entries.get(client)?.get(key);
    return {
      read: () => lookup()?.state ?? empty,
      subscribe: (listener: () => void) => {
        let scopes = entries.get(client);
        if (scopes === undefined) {
          scopes = new Map();
          entries.set(client, scopes);
        }
        const ownedScopes = scopes;
        let entry = ownedScopes.get(key);
        if (entry === undefined) {
          entry = new ScopeSnapshot(client, scope, () => ownedScopes.delete(key));
          ownedScopes.set(key, entry);
        }
        return entry.subscribe(listener);
      },
      refresh: () => lookup()?.refresh(true),
    };
  }, [client, key]);
  return {
    ...useSyncExternalStore(access.subscribe, access.read, readEmpty),
    refresh: access.refresh,
  };
}
