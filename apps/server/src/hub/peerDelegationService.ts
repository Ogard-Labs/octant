// The receiving spoke's side of a delegation. Another member of the hub asks
// this host for a remote child run; this host decides, as for any child run,
// whether it is within what the person here granted that member and what the
// Project here allows, then starts an ordinary thread in that Project under its
// own confinement and sign-ins. Nothing arrives with the request that could
// widen what it may do, and nothing the thread raises is answered from here:
// approvals go to this host's windows and to members it lets answer.

import {
  DelegationRequestId as DelegationRequestIdSchema,
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
const decodeRequestId = Schema.decodeUnknownSync(DelegationRequestIdSchema);
const MAX_SUMMARY = 8_192;
const MAX_FINAL_MESSAGE = 65_536;
// The status route allows 131,072 response bytes. Together these two take 98,304
// of them, leaving the rest for the artifact references and the envelope.
const MAX_SUMMARY_BYTES = 24_576;
const MAX_FINAL_MESSAGE_BYTES = 73_728;
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
  /** Reads the delegated turn, not whatever turn the thread has run since. */
  readonly readThread: (threadId: string, turnId: string) => Promise<ChildReading | undefined>;
  /** Interrupts the delegated turn only; a later turn on the thread is never touched. */
  readonly interrupt: (
    threadId: string,
    turnId: string,
  ) => Promise<"interrupted" | "already-finished" | "unavailable">;
}

export type StartedThread =
  | {
      readonly status: "started";
      readonly threadId: string;
      /** The turn that carries the delegated task. */
      readonly turnId: string;
    }
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

const encodedBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text)) - 2;

/**
 * Clips to a character count and then to a JSON-encoded byte budget, on a
 * character boundary. The status route's response budget is in bytes: CJK text
 * takes three per character and an emoji four, so a character cap alone can
 * overflow it and `limitResponse()` would cut the body into invalid JSON.
 */
function clipToBytes(text: string, maxLength: number, maxBytes: number): string {
  const clipped = clip(text, maxLength);
  if (encodedBytes(clipped) <= maxBytes) return clipped;
  let low = 0;
  let high = clipped.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encodedBytes(`${clipped.slice(0, middle).trimEnd()}…`) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Never end on half of a surrogate pair.
  const last = clipped.charCodeAt(low - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? low - 1 : low;
  return `${clipped.slice(0, end).trimEnd()}…`;
}

export class PeerDelegationService {
  readonly #options: PeerDelegationServiceOptions;
  /** Starts in flight by request id, so a repeat that arrives mid-start awaits the first instead of starting a second thread. */
  readonly #starting = new Map<
    string,
    { readonly senderMemberId: string; readonly outcome: Promise<DelegationReceipt> }
  >();

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
    const inFlight = this.#starting.get(requestKey);
    if (inFlight !== undefined) {
      // A repeat mid-start (the sender's timeout was shorter than the start) gets
      // the original start's outcome, so it never sees a refusal for a child that
      // is about to exist. Another sender cannot claim or probe the id.
      return inFlight.senderMemberId === String(principal.memberId)
        ? inFlight.outcome
        : refusal("request-id-in-use");
    }

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

    const outcome = this.#start(request, peer.member.name, principal, clamp.authority);
    this.#starting.set(requestKey, { senderMemberId: String(principal.memberId), outcome });
    try {
      return await outcome;
    } finally {
      this.#starting.delete(requestKey);
    }
  }

  async #start(
    request: ReturnType<typeof decodeDelegationRequest>,
    senderName: string,
    principal: PeerPrincipal,
    authority: DelegatedAuthority,
  ): Promise<DelegationReceipt> {
    const started = await this.#options.host.startThread({
      requestId: request.requestId,
      senderName,
      projectId: request.projectId,
      task: request.task,
      authority,
    });
    if (started.status === "refused") return refusal(started.kind);
    const received: ReceivedDelegation = {
      requestId: request.requestId,
      senderMemberId: principal.memberId,
      projectId: request.projectId,
      delegatedFrom: request.delegatedFrom,
      threadId: started.threadId,
      turnId: started.turnId,
      authority,
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
    return { status: "accepted", requestId: request.requestId, authority };
  }

  async status(signed: SignedRequest): Promise<DelegationStatusReceipt> {
    const found = this.#find(signed);
    if (found.status === "refused") return found;
    if (found.status === "starting") {
      // Told to the sender alone (see #find). A refusal here would read as "this
      // spoke never got the request" and the sender would forget a child that is
      // about to exist.
      return {
        status: "read",
        delegation: { requestId: decodeRequestId(found.requestId), state: "starting" },
      };
    }
    const reading = await this.#options.host.readThread(
      found.delegation.threadId,
      found.delegation.turnId,
    );
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
    const looked = this.#find(signed);
    if (looked.status === "refused") return looked;
    let found = looked;
    if (looked.status === "starting") {
      // A cancel that overtakes the start waits for it: otherwise the child
      // would start after the sender asked for it to stop, and run on.
      const started = await looked.outcome;
      if (started.status === "refused") return refusal("unknown-request");
      const delegation = this.#received(looked.requestId, looked.principal);
      if (delegation === undefined) return refusal("unknown-request");
      found = { ...looked, status: "found", delegation };
    }
    if (found.status !== "found") return refusal("unknown-request");
    const outcome = await this.#options.host.interrupt(
      found.delegation.threadId,
      found.delegation.turnId,
    );
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

  #received(requestId: string, principal: PeerPrincipal): ReceivedDelegation | undefined {
    return this.#options.state
      .load()
      .received.find(
        (entry) =>
          String(entry.requestId) === requestId &&
          String(entry.senderMemberId) === String(principal.memberId),
      );
  }

  /**
   * A delegation is read or cancelled only by the member that sent it. One still
   * starting is reported as such to that member alone, so a cancel can wait for it.
   */
  #find(signed: SignedRequest):
    | DelegationRefusal
    | {
        readonly status: "found";
        readonly delegation: ReceivedDelegation;
        readonly principal: PeerPrincipal;
        readonly selfMemberId: HubMemberId;
      }
    | {
        readonly status: "starting";
        readonly requestId: string;
        readonly outcome: Promise<DelegationReceipt>;
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
    const requestId = String(reference.requestId);
    const delegation = this.#received(requestId, authenticated.principal);
    if (delegation === undefined) {
      const inFlight = this.#starting.get(requestId);
      if (
        inFlight === undefined ||
        inFlight.senderMemberId !== String(authenticated.principal.memberId)
      ) {
        return refusal("unknown-request");
      }
      return {
        status: "starting",
        requestId,
        outcome: inFlight.outcome,
        principal: authenticated.principal,
        selfMemberId: authenticated.selfMemberId,
      };
    }
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
    const finalMessage = clipToBytes(
      reading.finalMessage?.trim() || NO_FINAL_MESSAGE,
      MAX_FINAL_MESSAGE,
      MAX_FINAL_MESSAGE_BYTES,
    );
    return {
      requestId: delegation.requestId,
      summary: clipToBytes(reading.summary?.trim() || finalMessage, MAX_SUMMARY, MAX_SUMMARY_BYTES),
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
