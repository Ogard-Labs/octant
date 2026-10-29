// The delegating spoke's side. Given a parent thread, a target member, a
// Project there, and a task, this host first checks its own rules (the parent
// thread's mode and authority, that helpers are allowed, that the target is a
// full member in the roster it holds), then sends the target a signed request.
// It tracks the remote child by reading its state from the target, and when the
// child completes it records the result here as external content with
// provenance. Nothing the target returns is an instruction on this host: the
// text reaches the parent thread framed as data, and the thread is marked as
// having read outside content.

import { randomUUID } from "node:crypto";
import {
  DelegationRequestId as DelegationRequestIdSchema,
  NO_LISTENER_PIN,
  UtcTimestamp,
  WorkThreadId as WorkThreadIdSchema,
  decodeCodeThreadId,
  decodeDelegationAccepted,
  decodeDelegationCancelAnswer,
  decodeDelegationStatus,
  type DelegatedAuthority,
  type DelegationRequest,
  type DelegationRequestId,
  type DelegationResult,
  type DelegationStartCommand,
  type HubDelegationRecordedPayload,
  type PeerDelegationMode,
  type PeerDelegationPosture,
  type RosterMember,
} from "@octant/contracts";
import { delegationPostureWithin } from "@octant/domain";
import { Schema } from "effect";
import { frameExternalContentForModel } from "../context/externalContentFraming";
import type { DelegationStatePort, SentDelegation } from "./delegationStateStore";
import { FRESHNESS_WINDOW_MS, HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import { listenerPinFromDigest } from "./hubCrypto";
import type { HubHostIdentity } from "./hubService";
import type { HubTransport } from "./pinnedHubTransport";
import { PEER_DELEGATION_ROUTES } from "./peerDelegationRoutes";
import type { MemberTarget } from "./spokeLinkService";

const decodeRequestId = Schema.decodeUnknownSync(DelegationRequestIdSchema);
const decodeWorkThreadId = Schema.decodeUnknownSync(WorkThreadIdSchema);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
/** The roster roles that run agents and so receive delegated work. */
const DELEGATION_TARGET_ROLES: ReadonlyArray<RosterMember["role"]> = ["spoke", "standby-hub"];
/**
 * How long a request whose answer was lost may still be on its way to the
 * target: its signature is accepted for the freshness window on either side of
 * the time it was signed. Past this, a target that does not know it never will.
 */
const UNCONFIRMED_REQUEST_MS = 2 * FRESHNESS_WINDOW_MS;

/** This host's own rules for a parent thread, judged where the thread lives. */
export interface DelegatingParentPort {
  readonly check: (input: {
    readonly mode: PeerDelegationMode;
    readonly threadId: string;
    readonly windowId: string;
  }) => ParentCheck;
  /**
   * Marks the parent thread as having read outside content. The host journals
   * the mark; the result text is never stored by it.
   */
  readonly ingest: (input: {
    readonly threadId: string;
    readonly sourceLabel: string;
    readonly contentReference: string;
    readonly correlationId: string;
  }) => "recorded" | "already-recorded" | "refused";
}

export type ParentCheck =
  | {
      readonly status: "allowed";
      /** The highest posture the parent thread itself runs at; a child never exceeds it. */
      readonly ceiling: PeerDelegationPosture;
    }
  | {
      readonly status: "refused";
      readonly kind:
        | "parent-unavailable"
        | "parent-mode-mismatch"
        | "subagents-off"
        | "subagents-not-allowed"
        | "parent-tainted"
        | "session-paused";
    };

export interface DelegatingSpokeOptions {
  readonly state: DelegationStatePort;
  readonly identity: () => HubHostIdentity;
  readonly target: (memberId: string) => MemberTarget;
  readonly transport: HubTransport;
  readonly parent: DelegatingParentPort;
  readonly record: (change: HubDelegationRecordedPayload) => void;
  readonly uuid?: () => string;
  readonly now: () => number;
}

export type DelegateOutcome =
  | {
      readonly status: "delegated";
      readonly requestId: DelegationRequestId;
      readonly authority: DelegatedAuthority;
    }
  /**
   * The target's answer was lost, so it may already run the child. The request
   * stays on file under this id; a later read or cancel settles it.
   */
  | { readonly status: "pending-acceptance"; readonly requestId: DelegationRequestId }
  | {
      readonly status: "refused";
      readonly kind:
        | Extract<ParentCheck, { readonly status: "refused" }>["kind"]
        | Extract<MemberTarget, { readonly status: "refused" }>["kind"]
        | "target-not-a-full-member"
        | "target-has-no-listener"
        | "mode-differs-from-parent"
        | "authority-above-parent"
        | "target-unreachable"
        | "target-answer-invalid";
    }
  | {
      readonly status: "refused-by-target";
      readonly httpStatus: number;
      readonly reason: string;
    };

/** The result of a delegation as the parent thread receives it: data, framed and marked. */
export interface RecordedDelegationResult {
  readonly requestId: DelegationRequestId;
  readonly result: DelegationResult;
  /** The text the parent thread's context holds, inside a data frame. */
  readonly framedText: string;
}

export type DelegationProgress =
  | { readonly status: "unknown-request" }
  | { readonly status: "target-unreachable" }
  | { readonly status: "refused-by-target"; readonly httpStatus: number; readonly reason: string }
  | {
      readonly status: "in-progress";
      readonly requestId: DelegationRequestId;
      readonly state: SentDelegation["state"];
    }
  | {
      readonly status: "ended";
      readonly requestId: DelegationRequestId;
      readonly state: "failed" | "cancelled";
    }
  | ({ readonly status: "completed" } & RecordedDelegationResult)
  | {
      readonly status: "already-recorded";
      readonly requestId: DelegationRequestId;
      /** Kept with the delegation, so every later read hands the result on again. */
      readonly result?: DelegationResult;
      readonly framedText?: string;
    };

export type DelegationCancellation =
  | { readonly status: "unknown-request" }
  | { readonly status: "target-unreachable" }
  | { readonly status: "refused-by-target"; readonly httpStatus: number; readonly reason: string }
  | { readonly status: "cancelled" | "already-finished"; readonly requestId: DelegationRequestId };

export class DelegatingSpokeService {
  readonly #options: DelegatingSpokeOptions;

  constructor(options: DelegatingSpokeOptions) {
    this.#options = options;
  }

  /** Every delegation this host sent for a parent thread, newest last. */
  listForParent(threadId: string): ReadonlyArray<SentDelegation> {
    return this.#options.state.load().sent.filter((entry) => entry.parent.threadId === threadId);
  }

  async delegate(
    command: DelegationStartCommand,
    context: { readonly windowId: string },
  ): Promise<DelegateOutcome> {
    const parent = this.#options.parent.check({
      mode: command.parent.mode,
      threadId: command.parent.threadId,
      windowId: context.windowId,
    });
    if (parent.status === "refused") return { status: "refused", kind: parent.kind };
    // A child is equal or narrower than its parent: the same mode (Work never
    // becomes Code) and a posture the parent itself runs at.
    if (command.authority.mode !== command.parent.mode) {
      return { status: "refused", kind: "mode-differs-from-parent" };
    }
    if (!delegationPostureWithin(command.authority.posture, parent.ceiling)) {
      return { status: "refused", kind: "authority-above-parent" };
    }
    const target = this.#options.target(String(command.targetMemberId));
    if (target.status === "refused") return { status: "refused", kind: target.kind };
    if (!DELEGATION_TARGET_ROLES.includes(target.member.role)) {
      return { status: "refused", kind: "target-not-a-full-member" };
    }
    const origin = memberOrigin(target.member);
    if (origin === undefined) return { status: "refused", kind: "target-has-no-listener" };

    const requestId = decodeRequestId((this.#options.uuid ?? randomUUID)());
    const request: DelegationRequest = {
      requestId,
      projectId: command.projectId,
      task: command.task,
      authority: command.authority,
      delegatedFrom: delegatedFromParent(command.parent, target.self),
    };
    // The target may start the child and then fail to tell this host (a lost
    // answer, the 8-second timeout). The request is on file before it leaves,
    // so such a child can always be read and cancelled by its id.
    const current = this.#options.state.load();
    this.#options.state.save({
      ...current,
      sent: [
        ...current.sent,
        {
          requestId,
          targetMemberId: command.targetMemberId,
          projectId: command.projectId,
          parent: command.parent,
          authority: command.authority,
          state: "awaiting-acceptance",
          sentAt: decodeTimestamp(new Date(this.#options.now()).toISOString()),
        },
      ],
    });
    const pending: DelegateOutcome = { status: "pending-acceptance", requestId };
    const answer = await this.#send(target, origin, PEER_DELEGATION_ROUTES.create, request);
    if (answer.status === "unreachable") return pending;
    if (!answer.response.ok) {
      const refusal = await refusalOf(answer.response);
      // A body that is not the target's own refusal (a proxy's error page) does
      // not say the target declined.
      if (refusal.reason === "unreadable") return pending;
      this.#remove(requestId);
      return { status: "refused-by-target", ...refusal };
    }
    let accepted;
    try {
      accepted = decodeDelegationAccepted(await answer.response.json());
    } catch {
      return pending;
    }
    if (String(accepted.requestId) !== String(requestId)) return pending;
    this.#update(requestId, { state: "running", authority: accepted.authority });
    this.#options.record({
      change: "sent",
      actingPrincipal: { kind: "local-window" },
      requestId,
      memberId: command.targetMemberId,
      projectId: command.projectId,
      delegatedFrom: request.delegatedFrom,
    });
    return { status: "delegated", requestId, authority: accepted.authority };
  }

  /** Erasing a parent thread erases what it delegated, a kept result included. */
  forgetParent(threadId: string): void {
    const current = this.#options.state.load();
    const kept = current.sent.filter((entry) => entry.parent.threadId !== threadId);
    if (kept.length !== current.sent.length) this.#options.state.save({ ...current, sent: kept });
  }

  /** Reads the remote child's state from its spoke and, once it completed, records its result here. */
  async refresh(requestId: string): Promise<DelegationProgress> {
    const sent = this.#find(requestId);
    if (sent === undefined) return { status: "unknown-request" };
    if (sent.resultRecorded === true) {
      return {
        status: "already-recorded",
        requestId: sent.requestId,
        ...(sent.result === undefined
          ? {}
          : {
              result: sent.result,
              framedText: frameResult(sent.result, String(sent.targetMemberId)).text,
            }),
      };
    }
    if (sent.state === "failed" || sent.state === "cancelled") {
      return { status: "ended", requestId: sent.requestId, state: sent.state };
    }
    const target = this.#options.target(String(sent.targetMemberId));
    const origin = target.status === "member" ? memberOrigin(target.member) : undefined;
    if (target.status !== "member" || origin === undefined) {
      return { status: "target-unreachable" };
    }
    const answer = await this.#send(target, origin, PEER_DELEGATION_ROUTES.status, {
      requestId: sent.requestId,
    });
    if (answer.status === "unreachable") return { status: "target-unreachable" };
    if (!answer.response.ok) {
      const refusal = await refusalOf(answer.response);
      if (sent.state === "awaiting-acceptance" && refusal.reason === "unknown-request") {
        // The target has no such request. It may still arrive until its
        // signature goes stale; after that it never will, and nothing runs.
        if (this.#options.now() - Date.parse(sent.sentAt) <= UNCONFIRMED_REQUEST_MS) {
          return { status: "in-progress", requestId: sent.requestId, state: sent.state };
        }
        this.#remove(sent.requestId);
        return { status: "unknown-request" };
      }
      return { status: "refused-by-target", ...refusal };
    }
    let status;
    try {
      status = decodeDelegationStatus(await answer.response.json());
    } catch {
      return { status: "target-unreachable" };
    }
    if (String(status.requestId) !== String(sent.requestId)) {
      return { status: "target-unreachable" };
    }
    if (sent.state === "awaiting-acceptance") {
      // The target does run the child: the lost answer was an acceptance.
      this.#update(sent.requestId, { state: status.state });
      this.#options.record({
        change: "sent",
        actingPrincipal: { kind: "local-window" },
        requestId: sent.requestId,
        memberId: sent.targetMemberId,
        projectId: sent.projectId,
        delegatedFrom: delegatedFromParent(sent.parent, target.self),
      });
    }
    if (status.state !== "completed" || status.result === undefined) {
      this.#update(sent.requestId, { state: status.state });
      return status.state === "failed" || status.state === "cancelled"
        ? { status: "ended", requestId: sent.requestId, state: status.state }
        : { status: "in-progress", requestId: sent.requestId, state: status.state };
    }
    return this.#recordResult(sent, status.result, target.member);
  }

  /** Reads every delegation that has not ended; a host runs this on a timer so results arrive unasked. */
  async trackOpen(): Promise<void> {
    for (const entry of this.#options.state.load().sent) {
      if (entry.resultRecorded === true) continue;
      if (entry.state === "failed" || entry.state === "cancelled") continue;
      await this.refresh(String(entry.requestId)).catch(() => undefined);
    }
  }

  /** Asks the target to interrupt one remote child. */
  async cancel(requestId: string): Promise<DelegationCancellation> {
    const sent = this.#find(requestId);
    if (sent === undefined) return { status: "unknown-request" };
    const target = this.#options.target(String(sent.targetMemberId));
    const origin = target.status === "member" ? memberOrigin(target.member) : undefined;
    if (target.status !== "member" || origin === undefined) {
      return { status: "target-unreachable" };
    }
    const answer = await this.#send(target, origin, PEER_DELEGATION_ROUTES.cancel, {
      requestId: sent.requestId,
    });
    if (answer.status === "unreachable") return { status: "target-unreachable" };
    if (!answer.response.ok) {
      return { status: "refused-by-target", ...(await refusalOf(answer.response)) };
    }
    let cancelled;
    try {
      cancelled = decodeDelegationCancelAnswer(await answer.response.json());
    } catch {
      return { status: "target-unreachable" };
    }
    if (cancelled.status === "cancelled") {
      this.#update(sent.requestId, { state: "cancelled" });
      this.#options.record({
        change: "cancel-sent",
        actingPrincipal: { kind: "local-window" },
        requestId: sent.requestId,
        memberId: sent.targetMemberId,
      });
    }
    return { status: cancelled.status, requestId: sent.requestId };
  }

  /** Cancelling a parent thread asks every target still running one of its children to interrupt it. */
  async cancelParent(threadId: string): Promise<ReadonlyArray<DelegationCancellation>> {
    const open = this.listForParent(threadId).filter(
      (entry) =>
        entry.resultRecorded !== true && entry.state !== "failed" && entry.state !== "cancelled",
    );
    return await Promise.all(open.map((entry) => this.cancel(String(entry.requestId))));
  }

  #recordResult(
    sent: SentDelegation,
    result: DelegationResult,
    target: RosterMember,
  ): DelegationProgress {
    // The result is data from another computer. It is framed as data and the
    // parent thread is marked as having read outside content before any of it
    // is handed on; if the mark cannot be written, nothing is handed on.
    const sourceLabel = peerSourceLabel(String(target.memberId));
    const ingested = this.#options.parent.ingest({
      threadId: sent.parent.threadId,
      sourceLabel,
      contentReference: `delegation-result:${String(sent.requestId)}`,
      correlationId: (this.#options.uuid ?? randomUUID)(),
    });
    if (ingested === "refused") return { status: "target-unreachable" };
    const framed = frameResult(result, String(target.memberId));
    // The background poll reaches here with nobody to hand the text to, so the
    // result is kept with the delegation before it counts as recorded.
    this.#update(sent.requestId, { state: "completed", resultRecorded: true, result });
    this.#options.record({
      change: "result-recorded",
      actingPrincipal: { kind: "local-window" },
      requestId: sent.requestId,
      memberId: sent.targetMemberId,
      projectId: sent.projectId,
    });
    return {
      status: "completed",
      requestId: sent.requestId,
      result,
      framedText: framed.text,
    };
  }

  #find(requestId: string): SentDelegation | undefined {
    return this.#options.state.load().sent.find((entry) => String(entry.requestId) === requestId);
  }

  #remove(requestId: DelegationRequestId): void {
    const current = this.#options.state.load();
    this.#options.state.save({
      ...current,
      sent: current.sent.filter((entry) => String(entry.requestId) !== String(requestId)),
    });
  }

  #update(requestId: DelegationRequestId, change: Partial<SentDelegation>): void {
    const current = this.#options.state.load();
    this.#options.state.save({
      ...current,
      sent: current.sent.map((entry) =>
        String(entry.requestId) === String(requestId) ? { ...entry, ...change } : entry,
      ),
    });
  }

  #send(
    target: Extract<MemberTarget, { readonly status: "member" }>,
    origin: string,
    path: string,
    body: unknown,
  ) {
    const identity = this.#options.identity();
    return sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin, pin: listenerPinFromDigest(target.member.listenerPin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(target.self),
      recipientMemberId: String(target.member.memberId),
      method: "POST",
      path,
      body: JSON.stringify(body),
      headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
      now: this.#options.now(),
    });
  }
}

/** The thread reference a request carries so the target knows which thread asked. */
function delegatedFromParent(
  parent: SentDelegation["parent"],
  self: RosterMember["memberId"],
): DelegationRequest["delegatedFrom"] {
  return parent.mode === "code"
    ? { kind: "code", memberId: self, threadId: decodeCodeThreadId(parent.threadId) }
    : { kind: "work", memberId: self, threadId: decodeWorkThreadId(parent.threadId) };
}

function peerSourceLabel(memberId: string): string {
  return `peer-delegation:${memberId}`;
}

/** A result as the parent thread receives it: data from another computer, inside a frame. */
function frameResult(result: DelegationResult, memberId: string) {
  return frameExternalContentForModel({
    origin: "tool-result",
    sourceLabel: peerSourceLabel(memberId),
    section: "subagent-results",
    body: delegationResultBody(result),
  });
}

/** The text of a result as the parent thread sees it, headed by where it came from. */
function delegationResultBody(result: DelegationResult): string {
  const artifacts =
    result.artifacts.length === 0
      ? ""
      : `\nArtifacts:\n${result.artifacts.map((artifact) => `- ${artifact.label} (${artifact.digest})`).join("\n")}`;
  return `Summary:\n${result.summary}\n\nFinal message:\n${result.finalMessage}${artifacts}`;
}

/** A member's listener origin from the roster entry that lists it; a guest has none. */
export function memberOrigin(member: RosterMember): string | undefined {
  if (member.listenerPin === NO_LISTENER_PIN) return undefined;
  const host = member.addresses[0] ?? member.privateNames[0];
  if (host === undefined) return undefined;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `https://${bracketed}${member.listenerPort === undefined ? "" : `:${member.listenerPort}`}`;
}

async function refusalOf(
  response: Response,
): Promise<{ readonly httpStatus: number; readonly reason: string }> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "kind" in body &&
      typeof body.kind === "string"
    ) {
      return { httpStatus: response.status, reason: body.kind.slice(0, 64) };
    }
  } catch {
    // The target's refusal had no readable reason; the status stands alone.
  }
  return { httpStatus: response.status, reason: "unreadable" };
}
