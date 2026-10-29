// The receiving spoke's side of a delegation. Another member of the hub asks
// this host for a remote child run; this host decides, as for any child run,
// whether it is within what the person here granted that member and what the
// Project here allows, then starts an ordinary thread in that Project under its
// own confinement and sign-ins. Nothing arrives with the request that could
// widen what it may do, and nothing the thread raises is answered from here:
// approvals go to this host's windows and to members it lets answer.

import {
  UtcTimestamp,
  decodeDelegationReference,
  decodeDelegationRequest,
  type DelegatedAuthority,
  type DelegationAccepted,
  type DelegationArtifactReference,
  type DelegationCancelAnswer,
  type DelegationChildState,
  type DelegationRequestId,
  type DelegationResult,
  type DelegationStatus,
  type HubDelegationRecordedPayload,
  type HubMemberId,
  type PeerPrincipal,
  type ProjectId,
} from "@octant/contracts";
import { clampDelegation, type DelegationProjectAuthority } from "@octant/domain";
import { Schema } from "effect";
import type { DelegationStatePort, ReceivedDelegation } from "./delegationStateStore";
import type { PeerRequestOutcome } from "./spokeLinkService";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const MAX_SUMMARY = 8_192;
const MAX_FINAL_MESSAGE = 65_536;
const NO_FINAL_MESSAGE = "The child finished without a final message.";

/** What this host's own Project, thread, and provider machinery does for a delegation. */
export interface PeerDelegationHost {
  /** Undefined when no such Project is open for delegated work here. */
  readonly projectAuthority: (projectId: ProjectId) => DelegationProjectAuthority | undefined;
  /**
   * Starts an ordinary thread in the Project at the clamped authority, under
   * this host's confinement and sign-ins, and sends the task as its first turn.
   */
  readonly startThread: (input: {
    readonly requestId: DelegationRequestId;
    readonly senderName: string;
    readonly projectId: ProjectId;
    readonly task: string;
    readonly authority: DelegatedAuthority;
  }) => Promise<StartedThread>;
  readonly readThread: (threadId: string) => Promise<ChildReading | undefined>;
  readonly interrupt: (
    threadId: string,
  ) => Promise<"interrupted" | "already-finished" | "unavailable">;
}

export type StartedThread =
  | { readonly status: "started"; readonly threadId: string }
  | {
      readonly status: "refused";
      readonly kind:
        | "project-unavailable"
        | "mode-unavailable"
        | "posture-unavailable"
        | "provider-unavailable"
        | "start-failed";
    };

export interface ChildReading {
  readonly state: DelegationChildState;
  readonly summary?: string;
  readonly finalMessage?: string;
  readonly artifacts: ReadonlyArray<DelegationArtifactReference>;
  readonly completedAt?: string;
}

export type DelegationRefusalKind =
  | Extract<PeerRequestOutcome, { readonly status: "refused" }>["kind"]
  | "guest-cannot-delegate"
  | "delegation-not-granted"
  | "project-mismatch"
  | "project-not-granted"
  | "project-unavailable"
  | "mode-not-granted"
  | "mode-unavailable"
  | "profile-not-granted"
  | "posture-unavailable"
  | "provider-unavailable"
  | "above-granted-authority"
  | "request-id-in-use"
  | "unknown-request"
  | "thread-unavailable"
  | "start-failed"
  | "invalid";

export type DelegationRefusal = {
  readonly status: "refused";
  readonly kind: DelegationRefusalKind;
  /** The highest posture this host would run the request at, when it refused for asking above it. */
  readonly allowedPosture?: DelegatedAuthority["posture"];
};

export type DelegationReceipt = DelegationAccepted | DelegationRefusal;
export type DelegationStatusReceipt =
  | ({ readonly status: "read" } & { readonly delegation: DelegationStatus })
  | DelegationRefusal;
export type DelegationCancelReceipt = DelegationCancelAnswer | DelegationRefusal;

export interface PeerDelegationServiceOptions {
  readonly authenticate: (input: {
    readonly header: string | null;
    readonly publicKey: string | null;
    readonly method: string;
    readonly path: string;
    readonly body: string;
  }) => PeerRequestOutcome;
  readonly host: PeerDelegationHost;
  readonly state: DelegationStatePort;
  readonly record: (change: HubDelegationRecordedPayload) => void;
  readonly now: () => number;
}

interface SignedRequest {
  readonly header: string | null;
  readonly publicKey: string | null;
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

function clip(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export class PeerDelegationService {
  readonly #options: PeerDelegationServiceOptions;
  /** Request ids being started now, so a repeat that arrives mid-start cannot start a second thread. */
  readonly #starting = new Set<string>();

  constructor(options: PeerDelegationServiceOptions) {
    this.#options = options;
  }

  async receive(signed: SignedRequest): Promise<DelegationReceipt> {
    const authenticated = this.#options.authenticate(signed);
    if (authenticated.status === "refused") return refusal(authenticated.kind);
    const { peer, principal } = authenticated;
    // A guest runs no agents and neither sends nor receives delegated work.
    if (peer.member.role === "guest") return refusal("guest-cannot-delegate");
    let request;
    try {
      request = decodeDelegationRequest(JSON.parse(signed.body));
    } catch {
      return refusal("invalid");
    }
    const requestKey = String(request.requestId);
    const state = this.#options.state.load();
    const existing = state.received.find((entry) => String(entry.requestId) === requestKey);
    if (existing !== undefined) {
      // The same sender repeating a request gets the answer it already had; no
      // second thread starts. Another sender cannot claim or probe the id.
      return String(existing.senderMemberId) === String(principal.memberId)
        ? { status: "accepted", requestId: existing.requestId, authority: existing.authority }
        : refusal("request-id-in-use");
    }
    if (this.#starting.has(requestKey)) return refusal("request-id-in-use");

    const project = this.#options.host.projectAuthority(request.projectId);
    if (project === undefined) return refusal("project-unavailable");
    const clamp = clampDelegation({ peer, request, project });
    if (clamp.status === "refused") return refusal(clamp.kind);
    // The clamp narrows; a request that asked for more than it allows is
    // refused rather than quietly run as something else.
    if (
      clamp.authority.posture !== request.authority.posture ||
      clamp.authority.mode !== request.authority.mode
    ) {
      return { ...refusal("above-granted-authority"), allowedPosture: clamp.authority.posture };
    }

    this.#starting.add(requestKey);
    try {
      const started = await this.#options.host.startThread({
        requestId: request.requestId,
        senderName: peer.member.name,
        projectId: request.projectId,
        task: request.task,
        authority: clamp.authority,
      });
      if (started.status === "refused") return refusal(started.kind);
      const received: ReceivedDelegation = {
        requestId: request.requestId,
        senderMemberId: principal.memberId,
        projectId: request.projectId,
        delegatedFrom: request.delegatedFrom,
        threadId: started.threadId,
        authority: clamp.authority,
        receivedAt: decodeTimestamp(new Date(this.#options.now()).toISOString()),
      };
      const current = this.#options.state.load();
      this.#options.state.save({ ...current, received: [...current.received, received] });
      this.#options.record({
        change: "received",
        actingPrincipal: principal,
        requestId: request.requestId,
        memberId: principal.memberId,
        projectId: request.projectId,
        delegatedFrom: request.delegatedFrom,
        threadId: started.threadId,
      });
      return { status: "accepted", requestId: request.requestId, authority: clamp.authority };
    } finally {
      this.#starting.delete(requestKey);
    }
  }

  async status(signed: SignedRequest): Promise<DelegationStatusReceipt> {
    const found = this.#find(signed);
    if (found.status === "refused") return found;
    const reading = await this.#options.host.readThread(found.delegation.threadId);
    if (reading === undefined) return refusal("thread-unavailable");
    const delegation: DelegationStatus = {
      requestId: found.delegation.requestId,
      state: reading.state,
      ...(reading.state === "completed"
        ? { result: this.#result(found.delegation, found.selfMemberId, reading) }
        : {}),
    };
    return { status: "read", delegation };
  }

  async cancel(signed: SignedRequest): Promise<DelegationCancelReceipt> {
    const found = this.#find(signed);
    if (found.status === "refused") return found;
    const outcome = await this.#options.host.interrupt(found.delegation.threadId);
    if (outcome === "unavailable") return refusal("thread-unavailable");
    if (outcome === "interrupted") {
      this.#options.record({
        change: "cancel-requested",
        actingPrincipal: found.principal,
        requestId: found.delegation.requestId,
        memberId: found.principal.memberId,
        threadId: found.delegation.threadId,
      });
    }
    return {
      status: outcome === "interrupted" ? "cancelled" : "already-finished",
      requestId: found.delegation.requestId,
    };
  }

  /** A delegation is read or cancelled only by the member that sent it. */
  #find(signed: SignedRequest):
    | DelegationRefusal
    | {
        readonly status: "found";
        readonly delegation: ReceivedDelegation;
        readonly principal: PeerPrincipal;
        readonly selfMemberId: HubMemberId;
      } {
    const authenticated = this.#options.authenticate(signed);
    if (authenticated.status === "refused") return refusal(authenticated.kind);
    let reference;
    try {
      reference = decodeDelegationReference(JSON.parse(signed.body));
    } catch {
      return refusal("invalid");
    }
    const delegation = this.#options.state
      .load()
      .received.find(
        (entry) =>
          String(entry.requestId) === String(reference.requestId) &&
          String(entry.senderMemberId) === String(authenticated.principal.memberId),
      );
    if (delegation === undefined) return refusal("unknown-request");
    return {
      status: "found",
      delegation,
      principal: authenticated.principal,
      selfMemberId: authenticated.selfMemberId,
    };
  }

  #result(
    delegation: ReceivedDelegation,
    selfMemberId: HubMemberId,
    reading: ChildReading,
  ): DelegationResult {
    const finalMessage = clip(reading.finalMessage?.trim() || NO_FINAL_MESSAGE, MAX_FINAL_MESSAGE);
    return {
      requestId: delegation.requestId,
      summary: clip(reading.summary?.trim() || finalMessage, MAX_SUMMARY),
      finalMessage,
      artifacts: reading.artifacts,
      provenance: {
        memberId: selfMemberId,
        projectId: delegation.projectId,
        completedAt: decodeTimestamp(
          reading.completedAt ?? new Date(this.#options.now()).toISOString(),
        ),
      },
    };
  }
}

function refusal(kind: DelegationRefusalKind): DelegationRefusal {
  return { status: "refused", kind };
}
