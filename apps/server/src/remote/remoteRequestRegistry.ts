// Process-scoped registry of authenticated remote requests and streams.
//
// Tracks active work by session digest and device so credential invalidation,
// sign-out, revoke, rotation, listener disable, and restart can cancel matching
// work synchronously after durable session invalidation. Diagnostics expose
// aggregate counts only — never entry, session, or device material.
//
// S2: Cancellation hooks are invoked inside a non-throwing wrapper. A hook
// that throws is recorded as a failure in the CancellationResult but the entry
// is RETAINED (not deleted) so the same target/hook can be retried by a
// subsequent cancellation call with the same scope. This ensures that a
// failed cancel hook does not lose the work target forever — retry with the
// same command ID re-invokes the retained hook. Entries are only removed when
// the hook succeeds, the stream completes normally, or the registry release
// function is called (normal completion path).

const DEFAULT_MAX_ENTRIES = 4_096;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RemoteRequestRegistration {
  readonly hostId: string;
  readonly deviceId: string;
  readonly sessionIdDigest: string;
  readonly cancel: () => void;
}

export interface RemoteRequestRegistryDiagnostics {
  readonly size: number;
  readonly maxEntries: number;
}

export interface CancellationResult {
  readonly canceled: number;
  readonly cancelHookFailures: number;
}

export interface RemoteRequestRegistry {
  readonly register: (input: RemoteRequestRegistration) => () => void;
  readonly cancelBySession: (sessionIdDigest: string) => CancellationResult;
  readonly cancelByDevice: (input: {
    readonly hostId: string;
    readonly deviceId: string;
  }) => CancellationResult;
  readonly cancelAll: () => CancellationResult;
  readonly size: () => number;
  readonly diagnostics: () => RemoteRequestRegistryDiagnostics;
}

export interface RemoteRequestRegistryOptions {
  readonly maxEntries?: number;
}

interface RegistryEntry extends RemoteRequestRegistration {
  readonly id: number;
  released: boolean;
  canceled: boolean;
  // S2: When true, the entry is retained after a failed cancel hook so it can
  // be retried. The entry is only removed when the hook succeeds or the
  // release function is called (normal completion).
  cancelHookFailed: boolean;
}

export function createRemoteRequestRegistry(
  options: RemoteRequestRegistryOptions = {},
): RemoteRequestRegistry {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("Remote request registry capacity is invalid.");
  }

  const entries = new Map<number, RegistryEntry>();
  let nextId = 1;

  const releaseEntry = (entry: RegistryEntry): void => {
    if (entry.released) return;
    entry.released = true;
    entries.delete(entry.id);
  };

  // S2: Cancel an entry. If the hook succeeds, the entry is released. If the
  // hook throws, the entry is RETAINED (cancelHookFailed = true) so a retry
  // can re-invoke the same hook. The entry is marked canceled so a subsequent
  // cancel call on the same entry reports it as already-canceled (but still
  // retries the hook if it failed).
  const cancelEntry = (entry: RegistryEntry): boolean | "hook-failed" => {
    if (entry.canceled && !entry.cancelHookFailed) {
      // Already successfully canceled — no-op.
      return false;
    }
    try {
      entry.cancel();
      entry.canceled = true;
      entry.cancelHookFailed = false;
      releaseEntry(entry);
      return true;
    } catch {
      entry.canceled = true;
      entry.cancelHookFailed = true;
      // S2: Do NOT release — retain for retry.
      return "hook-failed";
    }
  };

  return {
    register(input) {
      if (!UUID_PATTERN.test(input.hostId) || !UUID_PATTERN.test(input.deviceId)) {
        throw new Error("Remote request registration identity is invalid.");
      }
      if (!DIGEST_PATTERN.test(input.sessionIdDigest)) {
        throw new Error("Remote request registration requires a session digest.");
      }
      if (typeof input.cancel !== "function") {
        throw new Error("Remote request registration requires a cancel hook.");
      }
      if (entries.size >= maxEntries) {
        throw new Error("Remote request registry capacity exhausted.");
      }
      const entry: RegistryEntry = {
        id: nextId++,
        hostId: input.hostId,
        deviceId: input.deviceId,
        sessionIdDigest: input.sessionIdDigest,
        cancel: input.cancel,
        released: false,
        canceled: false,
        cancelHookFailed: false,
      };
      entries.set(entry.id, entry);
      return () => releaseEntry(entry);
    },

    cancelBySession(sessionIdDigest) {
      if (!DIGEST_PATTERN.test(sessionIdDigest)) return { canceled: 0, cancelHookFailures: 0 };
      let canceled = 0;
      let cancelHookFailures = 0;
      for (const entry of Array.from(entries.values())) {
        if (entry.sessionIdDigest === sessionIdDigest) {
          const result = cancelEntry(entry);
          if (result === true) canceled += 1;
          else if (result === "hook-failed") {
            canceled += 1;
            cancelHookFailures += 1;
          }
        }
      }
      return { canceled, cancelHookFailures };
    },

    cancelByDevice(input) {
      if (!UUID_PATTERN.test(input.hostId) || !UUID_PATTERN.test(input.deviceId)) {
        return { canceled: 0, cancelHookFailures: 0 };
      }
      let canceled = 0;
      let cancelHookFailures = 0;
      for (const entry of Array.from(entries.values())) {
        if (entry.hostId === input.hostId && entry.deviceId === input.deviceId) {
          const result = cancelEntry(entry);
          if (result === true) canceled += 1;
          else if (result === "hook-failed") {
            canceled += 1;
            cancelHookFailures += 1;
          }
        }
      }
      return { canceled, cancelHookFailures };
    },

    cancelAll() {
      let canceled = 0;
      let cancelHookFailures = 0;
      for (const entry of Array.from(entries.values())) {
        const result = cancelEntry(entry);
        if (result === true) canceled += 1;
        else if (result === "hook-failed") {
          canceled += 1;
          cancelHookFailures += 1;
        }
      }
      return { canceled, cancelHookFailures };
    },

    size() {
      return entries.size;
    },

    diagnostics() {
      return Object.freeze({
        size: entries.size,
        maxEntries,
      });
    },
  };
}
