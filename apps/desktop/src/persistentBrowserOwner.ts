import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  PersistentBrowserOwnerId,
  PersistentBrowserLeaseId,
  type PersistentBrowserLeaseBinding,
  type PersistentBrowserOwnerStatus,
  type PersistentBrowserContextCreated,
  type BrowserContextId,
  type BrowserContextPolicy,
} from "@octant/contracts";

export interface BrowserExecutionOwner {
  readonly kind: "execution";
  readonly ownerId: PersistentBrowserOwnerId;
  readonly leaseId: PersistentBrowserLeaseId;
  readonly threadId: string;
}
interface Lease {
  readonly contextId: BrowserContextId;
  readonly owner: BrowserExecutionOwner;
  readonly binding: PersistentBrowserLeaseBinding;
  readonly controller: AbortController;
  settled: boolean;
  closing?: Promise<"closed" | "unconfirmed">;
}

/** One native process/store; execution receipts never live in the journal. */
export function createPersistentBrowserOwner(options: {
  readonly exists: (contextId: BrowserContextId) => boolean;
  readonly open: (
    contextId: BrowserContextId,
    policy: BrowserContextPolicy,
    owner: BrowserExecutionOwner,
  ) => Promise<void>;
  readonly close: (contextId: BrowserContextId) => Promise<void>;
  readonly now?: () => number;
  readonly uuid?: () => string;
}) {
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? randomUUID;
  const leases = new Map<string, Lease>();
  let ownerId: PersistentBrowserOwnerId | undefined;
  let enabled = false;
  let stopped = false;
  const status = (): PersistentBrowserOwnerStatus =>
    !enabled
      ? { status: "disabled" }
      : stopped || ownerId === undefined
        ? { status: "unavailable" }
        : { status: "ready", ownerId };
  const current = (lease: Lease) =>
    !stopped &&
    enabled &&
    ownerId === lease.owner.ownerId &&
    !lease.controller.signal.aborted &&
    Date.parse(lease.binding.expiresAt) > now();
  const bounded = async <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const release = (id: PersistentBrowserLeaseId): Promise<"closed" | "unconfirmed"> => {
    const lease = leases.get(String(id));
    if (lease === undefined) return Promise.resolve("closed");
    lease.controller.abort();
    lease.closing ??= (async () => {
      // A late native create still owns its reservation. Releasing it before
      // the create settles could close another context or orphan that late view.
      if (!lease.settled) {
        await Promise.resolve();
        delete lease.closing;
        return "unconfirmed";
      }
      const closed = await bounded(
        Promise.resolve()
          .then(() => options.close(lease.contextId))
          .then(
            () => true,
            () => false,
          ),
        2000,
        false,
      );
      if (!closed) {
        delete lease.closing;
        return "unconfirmed";
      }
      if (leases.get(String(id)) === lease) leases.delete(String(id));
      return "closed";
    })();
    return lease.closing;
  };
  const retire = async () => {
    ownerId = undefined;
    await Promise.allSettled([...leases.values()].map((lease) => release(lease.owner.leaseId)));
  };
  return {
    status,
    configure: async (next: boolean): Promise<PersistentBrowserOwnerStatus> => {
      if (stopped) return { status: "unavailable" };
      if (next === enabled) return status();
      enabled = next;
      await retire();
      if (enabled && leases.size === 0)
        ownerId = Schema.decodeUnknownSync(PersistentBrowserOwnerId)(uuid());
      return status();
    },
    reserves: (contextId: string) =>
      [...leases.values()].some((lease) => String(lease.contextId) === contextId),
    admits: (owner: BrowserExecutionOwner) => {
      const lease = leases.get(String(owner.leaseId));
      return (
        lease !== undefined &&
        lease.owner.ownerId === owner.ownerId &&
        lease.owner.threadId === owner.threadId &&
        current(lease)
      );
    },
    createContext: async (
      contextId: BrowserContextId,
      policy: BrowserContextPolicy,
      signal: AbortSignal,
      binding: PersistentBrowserLeaseBinding,
    ): Promise<PersistentBrowserContextCreated> => {
      const expiry = Date.parse(binding.expiresAt);
      if (
        stopped ||
        !enabled ||
        ownerId === undefined ||
        binding.ownerId !== ownerId ||
        signal.aborted ||
        !(expiry > now() && expiry - now() <= 30 * 24 * 60 * 60 * 1000) ||
        leases.size >= 64 ||
        options.exists(contextId) ||
        [...leases.values()].some(
          (lease) =>
            lease.contextId === contextId || lease.binding.executionId === binding.executionId,
        ) ||
        policy.profileMode !== "isolated" ||
        !policy.credentialFieldProtection ||
        JSON.stringify(policy.profile) !== JSON.stringify(binding.profile) ||
        JSON.stringify([...new Set(policy.allowedOrigins)].sort()) !==
          JSON.stringify([...new Set(binding.origins)].sort()) ||
        (binding.profile.kind === "project" &&
          String(binding.profile.projectId) !== String(binding.projectId))
      )
        return { status: "unavailable" };
      const leaseId = Schema.decodeUnknownSync(PersistentBrowserLeaseId)(uuid());
      const lease: Lease = {
        contextId,
        binding,
        owner: { kind: "execution", ownerId, leaseId, threadId: String(binding.threadId) },
        controller: new AbortController(),
        settled: false,
      };
      leases.set(String(leaseId), lease);
      const abort = () => {
        void release(leaseId);
      };
      signal.addEventListener("abort", abort, { once: true });
      const opened = Promise.resolve().then(async () => {
        if (!current(lease) || signal.aborted) return false;
        try {
          await options.open(contextId, policy, lease.owner);
          return true;
        } catch {
          return false;
        }
      });
      void opened.then(() => {
        lease.settled = true;
        if (!current(lease)) void release(leaseId);
      });
      const created = await bounded(opened, 10000, false);
      signal.removeEventListener("abort", abort);
      if (!created || !current(lease) || signal.aborted) {
        await release(leaseId);
        return { status: "unavailable" };
      }
      return { status: "created", ownerId: lease.owner.ownerId, leaseId };
    },
    release,
    sweep: async () => {
      await Promise.allSettled(
        [...leases.values()]
          .filter((lease) => !current(lease))
          .map((lease) => release(lease.owner.leaseId)),
      );
    },
    restart: async () => {
      await retire();
      if (enabled && !stopped && leases.size === 0)
        ownerId = Schema.decodeUnknownSync(PersistentBrowserOwnerId)(uuid());
    },
    close: async () => {
      stopped = true;
      await retire();
    },
  };
}
export type PersistentBrowserOwner = ReturnType<typeof createPersistentBrowserOwner>;
