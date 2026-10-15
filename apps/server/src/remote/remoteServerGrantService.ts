import { randomBytes as defaultRandomBytes } from "node:crypto";
import {
  ActorId,
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActorDeviceId,
  EventId,
  EventName,
  REMOTE_SERVER_GRANT_CLOSED,
  REMOTE_SERVER_GRANT_OPENED,
  REMOTE_SERVER_GRANTS_PER_DEVICE,
  REMOTE_SERVER_GRANTS_PER_HOST,
  UtcTimestamp,
  decodeRemoteServerGrantClosedPayload,
  decodeRemoteServerGrantId,
  decodeRemoteServerGrantOpenedPayload,
  decodeRemoteServerGrantResult,
  type CodeThread,
  type CodeThreadId,
  type EventActor,
  type RemoteServerGrantCloseReason,
  type RemoteServerGrantId,
  type RemoteServerGrantOpenedPayload,
  type RemoteServerGrantRefusal,
  type RemoteServerGrantRequest,
  type RemoteServerGrantResult,
  type RemoteServerGrantSource,
  type WindowId,
} from "@octant/contracts";
import { decideRemoteServerGrant, type RemoteServerGrantThread } from "@octant/domain";
import { Schema } from "effect";
import type { RemoteServerGrantTarget } from "../localServers/localServerService";
import type { Journal } from "../persistence/journal";
import type { OpenRemoteServerGrantRecord } from "../persistence/remoteServerGrantProjection";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeEventActorDeviceId = Schema.decodeUnknownSync(EventActorDeviceId);
const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeEventName = Schema.decodeUnknownSync(EventName);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

export const REMOTE_SERVER_GRANT_AGGREGATE = "remote-server-grant";

/**
 * Who asks for a grant, from the request's authenticated principal. A paired
 * device's proxy session is part of it, because a grant is bound to the session
 * it was minted under and ends with it.
 */
export type RemoteServerGrantPrincipal =
  | { readonly kind: "local-window" }
  | {
      readonly kind: "remote-device";
      readonly deviceId: string;
      readonly credentialGeneration: number;
      readonly sessionIdDigest: string;
    };

export interface RemoteServerGrantOpenInput {
  readonly principal: RemoteServerGrantPrincipal;
  /** The request's service scope, which the listing and thread reads are judged under. */
  readonly scopeId: WindowId;
  readonly request: RemoteServerGrantRequest;
  /**
   * Asked once more just before a grant is minted, after every await: whether
   * the session and device the request was authenticated under still stand.
   */
  readonly stillAuthorized?: () => boolean;
  readonly signal?: AbortSignal;
}

/**
 * The answer to one grant request. `unavailable` is the host failing to look,
 * which is never a refusal of the server; `session-ended` is the proxy session
 * or device ending while the request was decided.
 */
export type RemoteServerGrantOpening =
  | { readonly kind: "answered"; readonly result: RemoteServerGrantResult }
  | { readonly kind: "unavailable" }
  | { readonly kind: "session-ended" };

export interface RemoteServerGrantServiceOptions {
  /** Re-observe the named listing under the request's scope, as Open and Stop do. */
  readonly observeTarget: (
    scopeId: WindowId,
    source: RemoteServerGrantSource,
    signal?: AbortSignal,
  ) => Promise<RemoteServerGrantTarget>;
  /** The remote read rule for a thread: whether this scope can open it. */
  readonly canOpenThread: (scopeId: WindowId, threadId: CodeThreadId) => Promise<boolean>;
  readonly readThread: (
    threadId: CodeThreadId,
  ) => Pick<CodeThread, "lifecycle" | "executionPolicy"> | undefined;
  /** Grants a past run of this host journaled as open. */
  readonly readOpenGrants: () => ReadonlyArray<OpenRemoteServerGrantRecord>;
  readonly journal: Pick<Journal, "append">;
  /** Speaks for the host when anything but the device itself ends a grant. */
  readonly hostActor: EventActor;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly limits?: { readonly perDevice?: number; readonly perHost?: number };
}

interface LiveGrant {
  readonly grantId: RemoteServerGrantId;
  readonly aggregateId: string;
  readonly deviceId: string;
  readonly credentialGeneration: number;
  readonly sessionIdDigest: string;
  readonly threadId: CodeThreadId;
  /** Where the host forwards, and the process that held it when the grant was minted. */
  readonly endpoint: {
    readonly url: string;
    readonly port: number;
    readonly pid: number;
    readonly processName: string;
  };
}

/**
 * Mints and closes grants to open one Octant-owned dev server from a paired
 * device.
 *
 * The host gathers every fact the grant policy needs itself: the principal from
 * the authenticated request, thread readability from the remote read rule, the
 * listener by re-observing the listing its id came from, ownership and health
 * from that observation, the thread from the worktree the server runs in, and
 * the posture from the thread. Nothing about the server comes from the client.
 *
 * Grants live in this host's memory, bound to the proxy session they were
 * minted under; the journal records each opening and closing. A host that
 * starts closes every grant a past run left open, because the session it was
 * bound to did not survive.
 */
export class RemoteServerGrantService {
  readonly #options: RemoteServerGrantServiceOptions;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #perDevice: number;
  readonly #perHost: number;
  readonly #grants = new Map<string, LiveGrant>();

  constructor(options: RemoteServerGrantServiceOptions) {
    this.#options = options;
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#perDevice = options.limits?.perDevice ?? REMOTE_SERVER_GRANTS_PER_DEVICE;
    this.#perHost = options.limits?.perHost ?? REMOTE_SERVER_GRANTS_PER_HOST;
  }

  async open(input: RemoteServerGrantOpenInput): Promise<RemoteServerGrantOpening> {
    const { principal, request } = input;
    if (principal.kind !== "remote-device") {
      // A local window opens the server directly; nothing about it is read.
      return this.#decided(request, { actor: "local-user", listener: { status: "not-listed" } });
    }

    // Readability before the listing: a device that cannot read the thread it
    // named learns nothing about which ids are listed in it.
    const named =
      request.source.surface === "local-servers"
        ? await this.#threadFact(input.scopeId, request.source.threadId)
        : undefined;
    if (named?.access === "unreadable") {
      return this.#decided(request, {
        actor: "remote-client",
        thread: named,
        listener: { status: "not-listed" },
      });
    }

    let target: RemoteServerGrantTarget;
    try {
      target = await this.#options.observeTarget(input.scopeId, request.source, input.signal);
    } catch {
      return { kind: "unavailable" };
    }
    if (target.status === "unavailable") return { kind: "unavailable" };
    if (target.status === "not-listed") {
      return this.#decided(request, {
        actor: "remote-client",
        ...(named === undefined ? {} : { thread: named }),
        listener: { status: "not-listed" },
      });
    }

    // Read the thread again after the observation: an archive, a lost read,
    // or a posture change while the host looked must decide this grant, not
    // the thread as it stood before.
    const threadId = target.threadId;
    const thread =
      threadId === undefined ? undefined : await this.#threadFact(input.scopeId, threadId);
    const decision = decideRemoteServerGrant({
      actor: "remote-client",
      ...(thread === undefined ? {} : { thread }),
      listener: { status: "listed", ownership: target.ownership, health: target.health },
    });
    if (decision.kind === "refuse") return refusedWith(request, decision.refusal);
    // The policy grants nothing without a thread, so this is never reached
    // without one; it keeps the compiler and a later policy change honest.
    if (threadId === undefined) {
      return refusedWith(request, { reason: "not-in-thread" });
    }

    if (input.stillAuthorized !== undefined && !input.stillAuthorized()) {
      return { kind: "session-ended" };
    }

    const reused = [...this.#grants.values()].find(
      (grant) =>
        grant.deviceId === principal.deviceId &&
        grant.sessionIdDigest === principal.sessionIdDigest &&
        String(grant.threadId) === String(threadId) &&
        grant.endpoint.pid === target.endpoint.pid &&
        grant.endpoint.port === target.endpoint.port &&
        grant.endpoint.url === target.endpoint.url,
    );
    if (reused !== undefined) return opened(request, reused);

    const held = [...this.#grants.values()].filter(
      (grant) => grant.deviceId === principal.deviceId,
    ).length;
    if (held >= this.#perDevice || this.#grants.size >= this.#perHost) {
      return refusedWith(request, { reason: "grant-limit" });
    }

    const grant: LiveGrant = {
      grantId: decodeRemoteServerGrantId(
        `rsg_${Buffer.from(this.#randomBytes(32)).toString("hex")}`,
      ),
      aggregateId: this.#options.uuid(),
      deviceId: principal.deviceId,
      credentialGeneration: principal.credentialGeneration,
      sessionIdDigest: principal.sessionIdDigest,
      threadId,
      endpoint: target.endpoint,
    };
    // Journaled before the grant exists: a grant nobody can find in the journal
    // is a grant nobody can account for.
    try {
      this.#append(
        grant.aggregateId,
        0,
        REMOTE_SERVER_GRANT_OPENED,
        deviceActor(grant.deviceId),
        payloadOf(grant),
      );
    } catch {
      return { kind: "unavailable" };
    }
    this.#grants.set(String(grant.grantId), grant);
    return opened(request, grant);
  }

  /** Close every grant bound to one proxy session. */
  closeSession(sessionIdDigest: string, reason: RemoteServerGrantCloseReason): void {
    this.#closeWhere((grant) => grant.sessionIdDigest === sessionIdDigest, reason);
  }

  closeDevice(deviceId: string, reason: RemoteServerGrantCloseReason): void {
    this.#closeWhere((grant) => grant.deviceId === deviceId, reason);
  }

  closeThread(threadId: string, reason: RemoteServerGrantCloseReason): void {
    this.#closeWhere((grant) => String(grant.threadId) === String(threadId), reason);
  }

  /** A server Octant stopped: every grant to the process that held that port. */
  closeServer(stopped: { readonly pid: number; readonly port: number }): void {
    this.#closeWhere(
      (grant) => grant.endpoint.pid === stopped.pid && grant.endpoint.port === stopped.port,
      "server-stopped",
    );
  }

  closeAll(reason: RemoteServerGrantCloseReason): void {
    this.#closeWhere(() => true, reason);
  }

  /**
   * Close what a past run of this host left open. Its proxy sessions lived in
   * that process's memory, so none of its grants can be presented again.
   */
  reconcile(): void {
    for (const record of this.#options.readOpenGrants()) {
      if (this.#grants.has(String(record.grant.grantId))) continue;
      try {
        this.#append(record.aggregateId, 1, REMOTE_SERVER_GRANT_CLOSED, this.#options.hostActor, {
          ...record.grant,
          reason: "proxy-session-ended",
        });
      } catch {
        console.warn("Octant could not record that a remote server grant ended.");
      }
    }
  }

  /** How many grants are open, for one device or the whole host. */
  openCount(deviceId?: string): number {
    if (deviceId === undefined) return this.#grants.size;
    return [...this.#grants.values()].filter((grant) => grant.deviceId === deviceId).length;
  }

  async #threadFact(scopeId: WindowId, threadId: CodeThreadId): Promise<RemoteServerGrantThread> {
    const thread = this.#options.readThread(threadId);
    // An archived thread holds no grant, since archiving closes one, so it is
    // refused as a thread this device cannot open servers in.
    if (thread === undefined || thread.lifecycle !== "active") return { access: "unreadable" };
    let readable: boolean;
    try {
      readable = await this.#options.canOpenThread(scopeId, threadId);
    } catch {
      readable = false;
    }
    return readable
      ? { access: "readable", posture: thread.executionPolicy }
      : { access: "unreadable" };
  }

  #decided(
    request: RemoteServerGrantRequest,
    facts: Parameters<typeof decideRemoteServerGrant>[0],
  ): RemoteServerGrantOpening {
    const decision = decideRemoteServerGrant(facts);
    if (decision.kind === "refuse") return refusedWith(request, decision.refusal);
    // Every call site above passes facts the policy refuses.
    return { kind: "unavailable" };
  }

  #closeWhere(matches: (grant: LiveGrant) => boolean, reason: RemoteServerGrantCloseReason): void {
    for (const grant of this.#grants.values()) {
      if (!matches(grant)) continue;
      this.#grants.delete(String(grant.grantId));
      try {
        this.#append(grant.aggregateId, 1, REMOTE_SERVER_GRANT_CLOSED, this.#options.hostActor, {
          ...payloadOf(grant),
          reason,
        });
      } catch {
        console.warn("Octant could not record that a remote server grant ended.");
      }
    }
  }

  #append(
    aggregateId: string,
    expectedVersion: number,
    eventName: typeof REMOTE_SERVER_GRANT_OPENED | typeof REMOTE_SERVER_GRANT_CLOSED,
    actor: EventActor,
    payload: unknown,
  ): void {
    const decoded =
      eventName === REMOTE_SERVER_GRANT_OPENED
        ? decodeRemoteServerGrantOpenedPayload(payload)
        : decodeRemoteServerGrantClosedPayload(payload);
    this.#options.journal.append({
      aggregate: {
        aggregateType: REMOTE_SERVER_GRANT_AGGREGATE,
        aggregateId: decodeAggregateId(aggregateId),
      },
      expectedVersion: decodeAggregateVersion(expectedVersion),
      events: [
        {
          eventId: decodeEventId(this.#options.uuid()),
          eventName: decodeEventName(eventName),
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#options.uuid()),
          actor,
          occurredAt: decodeTimestamp(this.#options.clock()),
          payload: decoded,
        },
      ],
    });
  }
}

function payloadOf(grant: LiveGrant): RemoteServerGrantOpenedPayload {
  return decodeRemoteServerGrantOpenedPayload({
    grantId: grant.grantId,
    deviceId: grant.deviceId,
    threadId: grant.threadId,
    port: grant.endpoint.port,
  });
}

/** The device that asked is the actor of its grant's opening. */
function deviceActor(deviceId: string): EventActor {
  return {
    kind: "remote-device",
    actorId: decodeActorId(deviceId),
    deviceId: decodeEventActorDeviceId(deviceId),
  };
}

function opened(request: RemoteServerGrantRequest, grant: LiveGrant): RemoteServerGrantOpening {
  return {
    kind: "answered",
    result: decodeRemoteServerGrantResult({
      kind: "remote-server-grant-opened",
      requestId: request.requestId,
      grant: { grantId: grant.grantId, threadId: grant.threadId, port: grant.endpoint.port },
    }),
  };
}

type PolicyRefusal =
  | Extract<ReturnType<typeof decideRemoteServerGrant>, { readonly kind: "refuse" }>["refusal"]
  | { readonly reason: "grant-limit" };

function refusedWith(
  request: RemoteServerGrantRequest,
  refusal: PolicyRefusal,
): RemoteServerGrantOpening {
  const wire: RemoteServerGrantRefusal =
    refusal.reason === "not-listening"
      ? { reason: "not-listening", health: refusal.health, message: REFUSAL_COPY["not-listening"] }
      : { reason: refusal.reason, message: REFUSAL_COPY[refusal.reason] };
  return {
    kind: "answered",
    result: decodeRemoteServerGrantResult({
      kind: "remote-server-grant-refused",
      requestId: request.requestId,
      refusal: wire,
    }),
  };
}

const REFUSAL_COPY: Record<RemoteServerGrantRefusal["reason"], string> = {
  "local-principal": "A window on this computer opens the server directly.",
  "thread-unreadable": "This device can't open servers in that thread.",
  "not-found": "That server stopped or changed. Open it again from its list.",
  "not-octant-owned": "Octant didn't start this server, so it opens only on its own computer.",
  "not-in-thread": "This server isn't in a thread, so it opens only on its own computer.",
  "not-listening": "That server isn't answering, so there is nothing to open.",
  "open-denied": "This thread doesn't let that server open from another computer.",
  "grant-limit": "This device has as many servers open as it may. Try again once one closes.",
};
