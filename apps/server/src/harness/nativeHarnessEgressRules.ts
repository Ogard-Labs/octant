import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  EventActor,
  EventId,
  MAX_LIVE_TOOL_EGRESS_RULES,
  MAX_OPEN_TOOL_EGRESS_PROPOSALS,
  MAX_TOOL_EGRESS_PROPOSALS_PER_LAUNCH,
  MAX_TOOL_EGRESS_SUMMARY_ENTRIES,
  NativeHarnessApprovalId,
  ProjectEgressRuleGrantedPayload,
  ProjectEgressRuleRevokedPayload,
  TOOL_EGRESS_EVENT_NAMES,
  TOOL_EGRESS_PROJECT_AGGREGATE,
  TOOL_EGRESS_THREAD_AGGREGATE,
  THREAD_EXTERNAL_CONTENT_AGGREGATE,
  THREAD_EXTERNAL_CONTENT_EVENT_NAMES,
  ThreadEgressDecisionsRecordedPayload,
  ThreadEgressLaunchIncompletePayload,
  ThreadEgressLaunchStartedPayload,
  ThreadEgressLaunchSummarizedPayload,
  ThreadEgressLearnModeSetPayload,
  ThreadEgressProposalDeclinedPayload,
  ThreadEgressProposalRaisedPayload,
  ThreadEgressRuleGrantedPayload,
  ThreadEgressRuleRevokedPayload,
  ToolEgressProposalHost,
  ToolEgressProposalId,
  ToolEgressRuleHost,
  ToolEgressRuleId,
  UtcTimestamp,
  type EventEnvelope,
  type ToolEgressDecisionEntry,
  type ToolEgressLaunch,
  type ToolEgressProjectRuleLifetime,
  type ToolEgressProposalView,
  type ToolEgressRuleView,
  type ToolEgressThreadRuleLifetime,
  type ToolEgressThreadView,
} from "@octant/contracts";
import {
  canonicalToolEgressRuleHost,
  decideToolEgressGrant,
  toolEgressRuleExpiresAt,
  toolEgressRuleLive,
  type ToolEgressGrantDecision,
  type ToolEgressRule,
  type ToolEgressRuleScope,
} from "@octant/domain/tool-egress-policy";
import { uptime } from "node:os";
import { Option, Schema } from "effect";
import type { Journal } from "../persistence/journal";
import {
  startToolEgressProxy,
  type ToolEgressProxy,
  type ToolEgressProxyClose,
  type ToolEgressProxyOptions,
  type ToolEgressRecordAppend,
} from "./nativeHarnessEgressProxy";

/**
 * The host's record of harness tool egress for every thread: the rules a
 * person granted, the learn-mode proposals waiting for a person, each
 * thread's learn-mode setting, and every proxied launch's audit records.
 * Canonical: docs/architecture.md § Harness tool egress rules.
 *
 * Everything here is rebuilt from the `thread-egress` and `project-egress`
 * aggregates, and nothing is in force before its event is appended: a grant
 * whose append fails grants nothing. Proposals are a separate record the
 * decision never reads, so they cannot allow anything however often they are
 * raised; only a person's answer, or a reviewer's for one launch, makes a
 * rule.
 */

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeActor = Schema.decodeUnknownSync(EventActor);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeApprovalId = Schema.decodeUnknownSync(NativeHarnessApprovalId);
const decodeRuleId = Schema.decodeUnknownSync(ToolEgressRuleId);
const decodeProposalId = Schema.decodeUnknownSync(ToolEgressProposalId);
const decodeRuleHostOption = Schema.decodeUnknownOption(ToolEgressRuleHost);
const decodeProposalHostOption = Schema.decodeUnknownOption(ToolEgressProposalHost);
const decodeTimestampOption = Schema.decodeUnknownOption(UtcTimestamp);

const PAYLOADS: Readonly<Record<string, Schema.Schema.AnyNoContext>> = {
  [TOOL_EGRESS_EVENT_NAMES.threadRuleGranted]: ThreadEgressRuleGrantedPayload,
  [TOOL_EGRESS_EVENT_NAMES.threadRuleRevoked]: ThreadEgressRuleRevokedPayload,
  [TOOL_EGRESS_EVENT_NAMES.projectRuleGranted]: ProjectEgressRuleGrantedPayload,
  [TOOL_EGRESS_EVENT_NAMES.projectRuleRevoked]: ProjectEgressRuleRevokedPayload,
  [TOOL_EGRESS_EVENT_NAMES.proposalRaised]: ThreadEgressProposalRaisedPayload,
  [TOOL_EGRESS_EVENT_NAMES.proposalDeclined]: ThreadEgressProposalDeclinedPayload,
  [TOOL_EGRESS_EVENT_NAMES.launchStarted]: ThreadEgressLaunchStartedPayload,
  [TOOL_EGRESS_EVENT_NAMES.decisionsRecorded]: ThreadEgressDecisionsRecordedPayload,
  [TOOL_EGRESS_EVENT_NAMES.launchSummarized]: ThreadEgressLaunchSummarizedPayload,
  [TOOL_EGRESS_EVENT_NAMES.launchIncomplete]: ThreadEgressLaunchIncompletePayload,
  [TOOL_EGRESS_EVENT_NAMES.learnModeSet]: ThreadEgressLearnModeSetPayload,
};

const LAUNCH_TAINT_REFERENCE_PREFIX = "tool-egress-launch:";

/**
 * The content reference a launch's taint is recorded under. One per launch,
 * so recording it again is a no-op and a journal that holds it shows the
 * launch's bytes already marked the thread.
 */
export function toolEgressLaunchTaintReference(launchId: string): string {
  return `${LAUNCH_TAINT_REFERENCE_PREFIX}${launchId}`;
}

const REPLAY_BATCH = 1_000;

/**
 * How long an expired rule stays in memory after this host first sees it
 * expired, counted on elapsed time rather than the wall clock. A request it
 * would have matched is refused `expired` until then and `no-rule` after, and
 * learn mode proposes both; either way the rule allows nothing once
 * `expiresAt` passes.
 */
export const EXPIRED_TOOL_EGRESS_RULE_RETENTION_MS = 24 * 3_600_000;
/** The least time between two sweeps of expired rules, which run when rules are read. */
const EXPIRED_RULE_SWEEP_INTERVAL_MS = 60_000;

/** Who answered: a person at a local window, a paired device, or the reviewer. */
export type ToolEgressAnsweringPrincipal =
  | { readonly kind: "local-window" }
  | { readonly kind: "remote-device"; readonly deviceId: string }
  | { readonly kind: "reviewer" };

/** A person who may take a rule away, turn a proposal down, or switch learn mode. */
export type ToolEgressPerson = Exclude<ToolEgressAnsweringPrincipal, { kind: "reviewer" }>;

export type ToolEgressGrantRequest = {
  readonly host: string;
  readonly port: number;
  readonly scope:
    | { readonly kind: "call"; readonly launchId: string }
    | { readonly kind: "thread"; readonly lifetime: ToolEgressThreadRuleLifetime }
    | { readonly kind: "project"; readonly lifetime: ToolEgressProjectRuleLifetime };
};

type GrantRefusal = Extract<ToolEgressGrantDecision, { kind: "refuse" }>["reason"];

export type ToolEgressAnswerOutcome =
  | { readonly kind: "answered"; readonly ruleIds: ReadonlyArray<ToolEgressRuleId> }
  | {
      readonly kind: "refused";
      readonly reason:
        | GrantRefusal
        | "not-a-code-thread"
        | "invalid-host"
        | "limit"
        | "rule-not-found"
        | "proposal-not-found"
        | "unavailable";
    };

export type ToolEgressLaunchStart =
  | { readonly status: "listening"; readonly launch: ToolEgressLiveLaunch }
  | { readonly status: "refused"; readonly reason: "listener-unavailable" | "audit-unavailable" };

export type ToolEgressLaunchEnd =
  | { readonly status: "summarized"; readonly summary: ThreadEgressLaunchSummarizedPayload }
  /** The summary or the thread's taint is not recorded, so the call reports `unavailable`. */
  | { readonly status: "unavailable" };

export interface ToolEgressLiveLaunch {
  readonly proxy: ToolEgressProxy;
  /**
   * Ends the launch: the proxy closes and summarizes, the launch's proposals
   * are raised, and a launch that received bytes taints its thread. The tool
   * result returns to the model only after this settles, and only when it is
   * `summarized`.
   */
  readonly finish: () => Promise<ToolEgressLaunchEnd>;
}

export interface ToolEgressRulesOptions {
  readonly journal: Pick<
    Journal,
    "append" | "replayAggregateType" | "aggregateVersions" | "transaction"
  >;
  /** The Code thread rules may be granted on, or nothing for any other thread. */
  readonly readCodeThread: (threadId: string) => { readonly projectId: string } | undefined;
  /** Whether the thread has taken in outside content. A read that throws counts as tainted. */
  readonly readThreadTaint: (threadId: string) => boolean;
  /**
   * Marks the thread as having taken in outside content because this launch
   * received bytes. It must be idempotent per launch: recovery calls it again
   * for launches whose mark it cannot see.
   */
  readonly recordLaunchTaint: (input: {
    readonly threadId: string;
    readonly launchId: string;
  }) => "recorded" | "unavailable";
  /** Speaks for the host: launch records, recovery, and a reviewer's answer. */
  readonly hostActor: typeof EventActor.Type;
  /** Speaks for the person at this host's windows. */
  readonly personActor: typeof EventActor.Type;
  readonly uuid: () => string;
  readonly clock: () => string;
  /**
   * Suspend-aware elapsed milliseconds that setting the wall clock cannot
   * move; the host's uptime unless a test supplies its own. Only the time an
   * expired rule stays in memory is counted on it.
   */
  readonly elapsedMs?: () => number;
}

interface StoredRule {
  readonly ruleId: ToolEgressRuleId;
  readonly host: ToolEgressRuleHost;
  readonly port: number;
  readonly scope: ToolEgressRuleScope;
  readonly expiresAt: UtcTimestamp;
  readonly grantedAt: UtcTimestamp;
  readonly grantedBy: ToolEgressAnsweringPrincipal["kind"];
}

interface StoredProposal {
  readonly payload: ThreadEgressProposalRaisedPayload;
  readonly raisedAt: UtcTimestamp;
}

interface OpenLaunch {
  readonly launch: ToolEgressLaunch;
  /** The journal position of its latest start; its decision batches come after it. */
  readonly startSequence: number;
  readonly entries: Map<string, ToolEgressDecisionEntry>;
}

interface LiveLaunchState {
  readonly proxy: ToolEgressProxy;
  readonly launch: ToolEgressLaunch;
  /** Distinct proposable refusals, at most sixteen; the rest are counted, not proposed. */
  readonly proposals: Map<
    string,
    { host: string; port: number; reason: "no-rule" | "expired"; attempts: number }
  >;
}

type AppendEvent = { readonly eventName: string; readonly payload: unknown };

export class ToolEgressRules {
  readonly #options: ToolEgressRulesOptions;
  readonly #hostActor: typeof EventActor.Type;
  readonly #personActor: typeof EventActor.Type;
  readonly #versions = new Map<string, number>();
  /** Call and thread rules, keyed by the thread whose aggregate holds them. */
  readonly #threadRules = new Map<string, Map<string, StoredRule>>();
  readonly #projectRules = new Map<string, Map<string, StoredRule>>();
  readonly #proposals = new Map<string, Map<string, StoredProposal>>();
  readonly #learnModeOff = new Set<string>();
  /** Launches started and neither summarized nor marked incomplete. */
  readonly #openLaunches = new Map<string, OpenLaunch>();
  /** Launches whose bytes taint their thread and whose mark this host has not confirmed. */
  readonly #unmarkedLaunches = new Map<string, string>();
  /** Launches whose taint the journal holds; a mark a person later cleared stays cleared. */
  readonly #markedLaunches = new Set<string>();
  /**
   * Host and port pairs a tainted launch asked for, per thread and per
   * Project. They stay after the proposal is declined or answered with a
   * `call` rule, so a standing rule typed in later is still refused.
   */
  readonly #taintedHostsByThread = new Map<string, Set<string>>();
  readonly #taintedHostsByProject = new Map<string, Set<string>>();
  /**
   * Aggregates holding a revocation this host could not read. Their rules are
   * not applied and no rule is granted on them: a revoked rule must not come
   * back because its record no longer decodes. Launch records still land.
   */
  readonly #unreadableAggregates = new Set<string>();
  readonly #live = new Map<string, LiveLaunchState>();
  readonly #elapsedMs: () => number;
  /** When expired rules are next swept from memory, in elapsed milliseconds. */
  #nextSweepAt = Number.NEGATIVE_INFINITY;
  /** When each held rule was first seen expired, in elapsed milliseconds. */
  readonly #seenExpiredAt = new WeakMap<StoredRule, number>();

  constructor(options: ToolEgressRulesOptions) {
    this.#options = options;
    this.#elapsedMs = options.elapsedMs ?? (() => uptime() * 1_000);
    this.#hostActor = decodeActor(options.hostActor);
    this.#personActor = decodeActor(options.personActor);
    this.#hydrate();
  }

  /**
   * Run at startup before a turn is admitted. A launch that started and was
   * never summarized is marked incomplete, and every launch whose bytes, or
   * unknown tail, taint its thread marks that thread now, so a crash between
   * a summary and its taint event cannot lose the mark.
   */
  recover(): { readonly incomplete: number; readonly unmarked: number } {
    let incomplete = 0;
    for (const [launchId, open] of this.#openLaunches) {
      if (this.#live.has(launchId)) continue;
      const entries = [...open.entries.values()];
      const allowed = entries.filter((entry) => entry.decision === "allowed");
      const payload = {
        launch: open.launch,
        recordedBytesSent: sum(allowed.map((entry) => entry.bytesSent)),
        recordedBytesReceived: sum(allowed.map((entry) => entry.bytesReceived)),
        entries: entries.slice(0, MAX_TOOL_EGRESS_SUMMARY_ENTRIES),
        truncated: entries.length > MAX_TOOL_EGRESS_SUMMARY_ENTRIES,
        tail: "unknown",
        threadTainted: this.#tainted(String(open.launch.threadId)),
      };
      const appended = this.#append(
        TOOL_EGRESS_THREAD_AGGREGATE,
        String(open.launch.threadId),
        [{ eventName: TOOL_EGRESS_EVENT_NAMES.launchIncomplete, payload }],
        this.#hostActor,
      );
      if (appended === "appended") {
        incomplete += 1;
      } else {
        // The record could not be written; the tail is still unknown, so the
        // thread is marked regardless.
        this.#unmarkedLaunches.set(launchId, String(open.launch.threadId));
      }
    }
    this.#markUnmarkedLaunches();
    return { incomplete, unmarked: this.#unmarkedLaunches.size };
  }

  /** Re-decides every open tunnel now, after a revocation or a taint change. */
  recheck(): void {
    for (const live of this.#live.values()) {
      try {
        live.proxy.recheck();
      } catch {
        // A proxy that cannot recheck shuts its tunnels at their next chunk.
      }
    }
  }

  /** A purged thread's events are gone from the journal; so is everything held for it. */
  forgetThread(threadId: string): void {
    this.#threadRules.delete(threadId);
    this.#taintedHostsByThread.delete(threadId);
    this.#unreadableAggregates.delete(aggregateKey(TOOL_EGRESS_THREAD_AGGREGATE, threadId));
    this.#proposals.delete(threadId);
    this.#learnModeOff.delete(threadId);
    this.#versions.delete(aggregateKey(TOOL_EGRESS_THREAD_AGGREGATE, threadId));
    for (const [launchId, open] of this.#openLaunches) {
      if (String(open.launch.threadId) === threadId) this.#openLaunches.delete(launchId);
    }
    for (const [launchId, owner] of this.#unmarkedLaunches) {
      if (owner === threadId) this.#unmarkedLaunches.delete(launchId);
    }
    this.recheck();
  }

  /** A Project's erased rules are gone from the journal; so is everything held for it. */
  forgetProject(projectId: string): void {
    this.#projectRules.delete(projectId);
    this.#unreadableAggregates.delete(aggregateKey(TOOL_EGRESS_PROJECT_AGGREGATE, projectId));
    this.#versions.delete(aggregateKey(TOOL_EGRESS_PROJECT_AGGREGATE, projectId));
    this.recheck();
  }

  /**
   * Starts the proxy for one launch. Its rules are the launch's own thread's,
   * or its parent's for a child, plus its Project's, read afresh for every
   * decision. A launch whose listener or start record fails gets no proxy
   * and must refuse before its command runs.
   */
  async startLaunch(
    input: Pick<
      ToolEgressProxyOptions,
      "launch" | "endpoint" | "resolveAll" | "connect" | "limits"
    >,
  ): Promise<ToolEgressLaunchStart> {
    const launch = input.launch;
    const proposals: LiveLaunchState["proposals"] = new Map();
    const started = await startToolEgressProxy({
      ...input,
      taint: () => ({
        threadTainted: this.#tainted(String(launch.threadId)),
        parentTainted:
          launch.parentThreadId === undefined
            ? false
            : this.#tainted(String(launch.parentThreadId)),
      }),
      rules: () => this.#rulesFor(launch),
      clock: this.#options.clock,
      records: {
        launchStarted: async (payload) => this.#record(launch, "launchStarted", payload),
        decisionsRecorded: async (payload) => this.#record(launch, "decisionsRecorded", payload),
        launchSummarized: async (payload) => this.#record(launch, "launchSummarized", payload),
      },
      onProposable: (refusal) => {
        const key = `${refusal.host} ${String(refusal.port)}`;
        const known = proposals.get(key);
        if (known !== undefined) {
          known.attempts += 1;
          return;
        }
        if (proposals.size >= MAX_TOOL_EGRESS_PROPOSALS_PER_LAUNCH) return;
        proposals.set(key, { ...refusal, attempts: 1 });
      },
    });
    if (started.status === "refused") return started;
    const state: LiveLaunchState = { proxy: started.proxy, launch, proposals };
    this.#live.set(String(launch.launchId), state);
    return {
      status: "listening",
      launch: { proxy: started.proxy, finish: () => this.#finish(state) },
    };
  }

  async #finish(state: LiveLaunchState): Promise<ToolEgressLaunchEnd> {
    let closed: ToolEgressProxyClose;
    try {
      closed = await state.proxy.close();
    } catch {
      closed = { status: "unavailable" };
    }
    this.#live.delete(String(state.launch.launchId));
    this.#retireCallRules(state.launch);
    // The launch's own taint is recorded before its proposals are raised, so
    // a child that took in outside bytes marks what it asked for as tainted.
    // A launch whose summary is not recorded has an unknown byte count, so it
    // taints its thread as recovery would.
    const marked =
      closed.status !== "summarized" || closed.summary.bytesReceived > 0
        ? this.#markLaunch(String(state.launch.threadId), String(state.launch.launchId))
        : "recorded";
    this.#raiseProposals(state);
    if (closed.status !== "summarized" || marked !== "recorded") return { status: "unavailable" };
    return closed;
  }

  /**
   * Answers a `network-access` approval: grants rules and turns down the
   * proposals the answer did not take. The taint is read now, so a thread
   * tainted while the person looked is refused a standing rule.
   */
  answer(input: {
    readonly threadId: string;
    readonly principal: ToolEgressAnsweringPrincipal;
    readonly grants: ReadonlyArray<ToolEgressGrantRequest>;
    readonly declineProposalIds?: ReadonlyArray<string>;
  }): ToolEgressAnswerOutcome {
    const thread = this.#options.readCodeThread(input.threadId);
    if (thread === undefined) return { kind: "refused", reason: "not-a-code-thread" };
    this.#sweepExpiredRules();
    const now = this.#timestamp();
    if (now === undefined) return { kind: "refused", reason: "unavailable" };
    const tainted = this.#tainted(input.threadId);
    const approvalId = decodeApprovalId(this.#options.uuid());
    const principal = input.principal;
    const threadEvents: AppendEvent[] = [];
    const projectEvents: AppendEvent[] = [];
    const ruleIds: ToolEgressRuleId[] = [];

    for (const grant of input.grants) {
      const host = Option.getOrUndefined(
        decodeRuleHostOption(canonicalToolEgressRuleHost(grant.host)),
      );
      if (host === undefined || !Number.isInteger(grant.port) || grant.port < 1) {
        return { kind: "refused", reason: "invalid-host" };
      }
      if (grant.port > 65_535) return { kind: "refused", reason: "invalid-host" };
      // A host a tainted launch asked for, a child's on a clean parent
      // included, is granted as if the thread were tainted: one launch only.
      // A Project rule reaches every thread of the Project, so it is checked
      // against what any of them asked for while tainted.
      const askedWhileTainted =
        matchesTaintedHost(this.#taintedHostsByThread.get(input.threadId), host, grant.port) ||
        (grant.scope.kind === "project" &&
          matchesTaintedHost(this.#taintedHostsByProject.get(thread.projectId), host, grant.port));
      const decision = decideToolEgressGrant({
        principal: input.principal.kind,
        scope: grant.scope.kind,
        threadTainted: tainted || askedWhileTainted,
      });
      if (decision.kind === "refuse") return { kind: "refused", reason: decision.reason };
      const lifetime = grant.scope.kind === "call" ? "call" : grant.scope.lifetime;
      const expiresAt = toolEgressRuleExpiresAt(lifetime, now);
      if (expiresAt === undefined) return { kind: "refused", reason: "unavailable" };
      const ruleId = decodeRuleId(this.#options.uuid());
      ruleIds.push(ruleId);
      if (grant.scope.kind === "project") {
        projectEvents.push({
          eventName: TOOL_EGRESS_EVENT_NAMES.projectRuleGranted,
          payload: {
            ruleId,
            projectId: thread.projectId,
            threadId: input.threadId,
            host,
            port: grant.port,
            expiresAt,
            principal,
            approvalId,
            threadTainted: tainted,
          },
        });
      } else {
        threadEvents.push({
          eventName: TOOL_EGRESS_EVENT_NAMES.threadRuleGranted,
          payload: {
            ruleId,
            threadId: input.threadId,
            host,
            port: grant.port,
            scope:
              grant.scope.kind === "call"
                ? { kind: "call", launchId: grant.scope.launchId }
                : { kind: "thread" },
            expiresAt,
            principal,
            approvalId,
            threadTainted: tainted,
          },
        });
      }
    }
    if (
      this.#liveCount(this.#threadRules.get(input.threadId), now) + threadEvents.length >
        MAX_LIVE_TOOL_EGRESS_RULES ||
      this.#liveCount(this.#projectRules.get(thread.projectId), now) + projectEvents.length >
        MAX_LIVE_TOOL_EGRESS_RULES
    ) {
      return { kind: "refused", reason: "limit" };
    }
    if (input.principal.kind !== "reviewer") {
      const open = this.#proposals.get(input.threadId);
      const declined = (input.declineProposalIds ?? []).filter((id) => open?.has(id) === true);
      if (declined.length > 0) {
        threadEvents.push({
          eventName: TOOL_EGRESS_EVENT_NAMES.proposalDeclined,
          payload: {
            threadId: input.threadId,
            proposalIds: declined,
            principal: input.principal,
            threadTainted: tainted,
          },
        });
      }
    }
    const actor = this.#actorFor(input.principal);
    // Both aggregates commit together or not at all, so an answer never lands in part.
    const appended = this.#appendAll(
      [
        {
          aggregateType: TOOL_EGRESS_THREAD_AGGREGATE,
          aggregateId: input.threadId,
          events: threadEvents,
        },
        {
          aggregateType: TOOL_EGRESS_PROJECT_AGGREGATE,
          aggregateId: thread.projectId,
          events: projectEvents,
        },
      ],
      actor,
    );
    return appended === "appended"
      ? { kind: "answered", ruleIds }
      : { kind: "refused", reason: "unavailable" };
  }

  decline(input: {
    readonly threadId: string;
    readonly principal: ToolEgressPerson;
    readonly proposalIds: ReadonlyArray<string>;
  }): ToolEgressAnswerOutcome {
    if (this.#options.readCodeThread(input.threadId) === undefined) {
      return { kind: "refused", reason: "not-a-code-thread" };
    }
    const open = this.#proposals.get(input.threadId);
    const declined = input.proposalIds.filter((id) => open?.has(id) === true);
    if (declined.length === 0) return { kind: "refused", reason: "proposal-not-found" };
    const appended = this.#append(
      TOOL_EGRESS_THREAD_AGGREGATE,
      input.threadId,
      [
        {
          eventName: TOOL_EGRESS_EVENT_NAMES.proposalDeclined,
          payload: {
            threadId: input.threadId,
            proposalIds: declined,
            principal: input.principal,
            threadTainted: this.#tainted(input.threadId),
          },
        },
      ],
      this.#actorFor(input.principal),
    );
    return appended === "appended"
      ? { kind: "answered", ruleIds: [] }
      : { kind: "refused", reason: "unavailable" };
  }

  /** Takes a thread's or its Project's rule away; open tunnels it allowed close at once. */
  revoke(input: {
    readonly threadId: string;
    readonly principal: ToolEgressPerson;
    readonly ruleId: string;
  }): ToolEgressAnswerOutcome {
    const thread = this.#options.readCodeThread(input.threadId);
    if (thread === undefined) return { kind: "refused", reason: "not-a-code-thread" };
    this.#sweepExpiredRules();
    const actor = this.#actorFor(input.principal);
    let appended: "appended" | "unavailable";
    if (this.#threadRules.get(input.threadId)?.has(input.ruleId) === true) {
      appended = this.#append(
        TOOL_EGRESS_THREAD_AGGREGATE,
        input.threadId,
        [
          {
            eventName: TOOL_EGRESS_EVENT_NAMES.threadRuleRevoked,
            payload: {
              ruleId: input.ruleId,
              threadId: input.threadId,
              principal: input.principal,
              threadTainted: this.#tainted(input.threadId),
            },
          },
        ],
        actor,
      );
    } else if (this.#projectRules.get(thread.projectId)?.has(input.ruleId) === true) {
      appended = this.#append(
        TOOL_EGRESS_PROJECT_AGGREGATE,
        thread.projectId,
        [
          {
            eventName: TOOL_EGRESS_EVENT_NAMES.projectRuleRevoked,
            payload: {
              ruleId: input.ruleId,
              projectId: thread.projectId,
              principal: input.principal,
            },
          },
        ],
        actor,
      );
    } else {
      return { kind: "refused", reason: "rule-not-found" };
    }
    if (appended !== "appended") return { kind: "refused", reason: "unavailable" };
    this.recheck();
    return { kind: "answered", ruleIds: [] };
  }

  setLearnMode(input: {
    readonly threadId: string;
    readonly principal: ToolEgressPerson;
    readonly enabled: boolean;
  }): ToolEgressAnswerOutcome {
    if (this.#options.readCodeThread(input.threadId) === undefined) {
      return { kind: "refused", reason: "not-a-code-thread" };
    }
    const appended = this.#append(
      TOOL_EGRESS_THREAD_AGGREGATE,
      input.threadId,
      [
        {
          eventName: TOOL_EGRESS_EVENT_NAMES.learnModeSet,
          payload: { threadId: input.threadId, enabled: input.enabled, principal: input.principal },
        },
      ],
      this.#actorFor(input.principal),
    );
    return appended === "appended"
      ? { kind: "answered", ruleIds: [] }
      : { kind: "refused", reason: "unavailable" };
  }

  /** The thread's rules lists and open proposals as this caller may act on them. */
  view(threadId: string, caller: ToolEgressPerson["kind"]): ToolEgressThreadView | undefined {
    const thread = this.#options.readCodeThread(threadId);
    if (thread === undefined) return undefined;
    this.#sweepExpiredRules();
    const now = this.#timestamp() ?? "";
    const tainted = this.#tainted(threadId);
    const live = (rules: Map<string, StoredRule> | undefined): ToolEgressRuleView[] =>
      [...(rules?.values() ?? [])]
        .filter((rule) => toolEgressRuleLive(rule.expiresAt, now))
        .toSorted((left, right) => left.grantedAt.localeCompare(right.grantedAt))
        .map((rule) => ({
          ruleId: rule.ruleId,
          host: rule.host,
          port: rule.port,
          scope: rule.scope.kind,
          expiresAt: rule.expiresAt,
          grantedAt: rule.grantedAt,
          grantedBy: rule.grantedBy,
        }));
    const proposals: ToolEgressProposalView[] = [
      ...(this.#proposals.get(threadId)?.values() ?? []),
    ].map(({ payload, raisedAt }) => ({
      proposalId: payload.proposalId,
      host: payload.host,
      port: payload.port,
      reason: payload.reason,
      attempts: payload.attempts,
      raisedAt,
      threadTainted: payload.threadTainted,
      ...(String(payload.launch.threadId) === threadId
        ? {}
        : { childThreadId: payload.launch.threadId }),
    }));
    return {
      threadId: decodeAggregateId(threadId),
      projectId: decodeAggregateId(thread.projectId),
      // Commands do not run through the proxy until confinement routes them there.
      enforced: false,
      learnMode: !this.#learnModeOff.has(threadId),
      threadTainted: tainted,
      projectGrant: tainted
        ? "thread-tainted"
        : caller === "local-window"
          ? "allowed"
          : "needs-local-window",
      // An aggregate whose revocations cannot be read shows, and allows, nothing.
      threadRules: this.#unreadableAggregates.has(
        aggregateKey(TOOL_EGRESS_THREAD_AGGREGATE, threadId),
      )
        ? []
        : live(this.#threadRules.get(threadId)).slice(0, MAX_LIVE_TOOL_EGRESS_RULES),
      projectRules: this.#unreadableAggregates.has(
        aggregateKey(TOOL_EGRESS_PROJECT_AGGREGATE, thread.projectId),
      )
        ? []
        : live(this.#projectRules.get(thread.projectId)).slice(0, MAX_LIVE_TOOL_EGRESS_RULES),
      proposals: proposals.slice(0, MAX_OPEN_TOOL_EGRESS_PROPOSALS),
    };
  }

  /**
   * The launch's thread's rules, or its parent's for a child, and its
   * Project's. The decision applies scope, launch, taint, and expiry; a
   * proposal is never among them.
   */
  #rulesFor(launch: ToolEgressLaunch): ReadonlyArray<ToolEgressRule> {
    this.#sweepExpiredRules();
    const ruleThread = String(launch.parentThreadId ?? launch.threadId);
    const readable = (aggregateType: string, id: string) =>
      !this.#unreadableAggregates.has(aggregateKey(aggregateType, id));
    return [
      ...(readable(TOOL_EGRESS_THREAD_AGGREGATE, ruleThread)
        ? (this.#threadRules.get(ruleThread)?.values() ?? [])
        : []),
      ...(readable(TOOL_EGRESS_PROJECT_AGGREGATE, String(launch.projectId))
        ? (this.#projectRules.get(String(launch.projectId))?.values() ?? [])
        : []),
    ].map((rule) => ({
      id: rule.ruleId,
      scope: rule.scope,
      host: rule.host,
      port: rule.port,
      expiresAt: rule.expiresAt,
    }));
  }

  /**
   * Raises what the launch was refused for as proposals on the thread a
   * person answers: the launch's own, or its parent's for a child. A host
   * already proposed and still open is not proposed twice; past sixty-four
   * open proposals a refusal is only counted in the launch's records.
   */
  #raiseProposals(state: LiveLaunchState): void {
    if (state.proposals.size === 0) return;
    const threadId = String(state.launch.parentThreadId ?? state.launch.threadId);
    if (this.#learnModeOff.has(threadId)) return;
    const open = this.#proposals.get(threadId) ?? new Map<string, StoredProposal>();
    const openTaint = new Map<string, boolean>();
    for (const { payload } of open.values()) {
      const key = hostKey(payload.host, payload.port);
      openTaint.set(key, openTaint.get(key) === true || payload.threadTainted);
    }
    // The launch's own thread counts too: a child tainted on a clean parent
    // proposes as tainted.
    const tainted = this.#tainted(threadId) || this.#tainted(String(state.launch.threadId));
    const events: AppendEvent[] = [];
    let added = 0;
    for (const [key, refusal] of state.proposals) {
      const host = Option.getOrUndefined(decodeProposalHostOption(refusal.host));
      if (host === undefined) continue;
      // A host already open is proposed again only to mark it tainted; the
      // tainted proposal replaces the clean one.
      const openWasTainted = openTaint.get(key);
      if (openWasTainted !== undefined && (openWasTainted || !tainted)) continue;
      if (openWasTainted === undefined) {
        if (open.size + added >= MAX_OPEN_TOOL_EGRESS_PROPOSALS) continue;
        added += 1;
      }
      events.push({
        eventName: TOOL_EGRESS_EVENT_NAMES.proposalRaised,
        payload: {
          proposalId: decodeProposalId(this.#options.uuid()),
          threadId,
          launch: state.launch,
          host,
          port: refusal.port,
          reason: refusal.reason,
          attempts: refusal.attempts,
          threadTainted: tainted,
        },
      });
    }
    if (events.length === 0) return;
    // A proposal that cannot be recorded is a suggestion lost, never a grant.
    this.#append(TOOL_EGRESS_THREAD_AGGREGATE, threadId, events, this.#hostActor);
  }

  #record(
    launch: ToolEgressLaunch,
    record: "launchStarted" | "decisionsRecorded" | "launchSummarized",
    payload: unknown,
  ): ToolEgressRecordAppend {
    return {
      status: this.#append(
        TOOL_EGRESS_THREAD_AGGREGATE,
        String(launch.threadId),
        [{ eventName: TOOL_EGRESS_EVENT_NAMES[record], payload }],
        this.#hostActor,
      ),
    };
  }

  #markUnmarkedLaunches(): void {
    for (const [launchId, threadId] of this.#unmarkedLaunches) {
      this.#markLaunch(threadId, launchId);
    }
  }

  #markLaunch(threadId: string, launchId: string): "recorded" | "unavailable" {
    let marked: "recorded" | "unavailable";
    try {
      marked = this.#options.recordLaunchTaint({ threadId, launchId });
    } catch {
      marked = "unavailable";
    }
    if (marked === "recorded") {
      this.#unmarkedLaunches.delete(launchId);
      this.#markedLaunches.add(launchId);
    } else {
      this.#unmarkedLaunches.set(launchId, threadId);
    }
    return marked;
  }

  /**
   * The thread's taint for every egress decision and grant. A read that
   * throws, or a launch whose taint this host could not record, counts as
   * tainted, so standing rules stay suspended until the mark is written.
   */
  #tainted(threadId: string): boolean {
    for (const owner of this.#unmarkedLaunches.values()) {
      if (owner === threadId) return true;
    }
    try {
      return this.#options.readThreadTaint(threadId);
    } catch {
      return true;
    }
  }

  #liveCount(rules: Map<string, StoredRule> | undefined, now: string): number {
    let count = 0;
    for (const rule of rules?.values() ?? []) {
      if (toolEgressRuleLive(rule.expiresAt, now)) count += 1;
    }
    return count;
  }

  /**
   * Drops rules that have been expired for the retention, at most once a
   * minute. Both the minute and the retention run on elapsed time from when
   * this host first saw a rule expired, so a wall clock set forward drops
   * nothing early (a rule live again once the clock is corrected is still
   * held) and one set back does not stop the sweeps. Expiry itself is decided
   * from `expiresAt` on every request whether or not a rule is still held, so
   * a sweep that is late, skipped, or stopped by an unreadable clock changes
   * no decision.
   */
  #sweepExpiredRules(force = false): void {
    let nowMs: number;
    let elapsed: number;
    try {
      nowMs = Date.parse(this.#options.clock());
      elapsed = this.#elapsedMs();
    } catch {
      return;
    }
    if (!Number.isFinite(nowMs) || !Number.isFinite(elapsed)) return;
    if (!force && elapsed < this.#nextSweepAt) return;
    this.#nextSweepAt = elapsed + EXPIRED_RULE_SWEEP_INTERVAL_MS;
    for (const held of [this.#threadRules, this.#projectRules]) {
      for (const [owner, rules] of held) {
        for (const [ruleId, rule] of rules) {
          // An unreadable expiry is never held as expired here; the decision
          // still refuses it.
          if (!(nowMs >= Date.parse(rule.expiresAt))) {
            this.#seenExpiredAt.delete(rule);
            continue;
          }
          const seen = this.#seenExpiredAt.get(rule);
          if (seen === undefined) {
            this.#seenExpiredAt.set(rule, elapsed);
          } else if (elapsed - seen >= EXPIRED_TOOL_EGRESS_RULE_RETENTION_MS) {
            rules.delete(ruleId);
          }
        }
        if (rules.size === 0) held.delete(owner);
      }
    }
  }

  #timestamp(): string | undefined {
    try {
      return Option.getOrUndefined(decodeTimestampOption(this.#options.clock()));
    } catch {
      return undefined;
    }
  }

  #actorFor(principal: ToolEgressAnsweringPrincipal): typeof EventActor.Type {
    switch (principal.kind) {
      case "local-window":
        return this.#personActor;
      case "remote-device":
        return decodeActor({
          kind: "remote-device",
          actorId: this.#personActor.actorId,
          deviceId: principal.deviceId,
        });
      case "reviewer":
        return this.#hostActor;
    }
  }

  /**
   * Appends to one aggregate and applies what was appended. Nothing is in
   * force before the journal holds it: a payload that does not decode, a
   * conflict, or a journal that throws leaves the state as it was.
   */
  #append(
    aggregateType: string,
    aggregateId: string,
    events: ReadonlyArray<AppendEvent>,
    actor: typeof EventActor.Type,
  ): "appended" | "unavailable" {
    return this.#appendAll([{ aggregateType, aggregateId, events }], actor);
  }

  /**
   * Appends to each aggregate in one journal unit and applies what was
   * appended only once the whole unit commits. Nothing is in force before
   * the journal holds it: a payload that does not decode, a conflict, an
   * aggregate whose revocations cannot be read, or a journal that throws
   * leaves the journal and the state as they were.
   */
  #appendAll(
    batches: ReadonlyArray<{
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly events: ReadonlyArray<AppendEvent>;
    }>,
    actor: typeof EventActor.Type,
  ): "appended" | "unavailable" {
    const writes = batches.filter((batch) => batch.events.length > 0);
    if (writes.length === 0) return "appended";
    const occurredAt = this.#timestamp();
    if (occurredAt === undefined) return "unavailable";
    let committed: ReadonlyArray<EventEnvelope>;
    try {
      committed = this.#options.journal.transaction(() =>
        writes.flatMap(({ aggregateType, aggregateId, events }) => {
          const key = aggregateKey(aggregateType, aggregateId);
          if (this.#unreadableAggregates.has(key) && events.some(grantsRule)) {
            throw new Error("A rule cannot be granted where a revocation is unreadable.");
          }
          return this.#options.journal.append({
            aggregate: { aggregateType, aggregateId: decodeAggregateId(aggregateId) },
            expectedVersion: decodeAggregateVersion(this.#versions.get(key) ?? 0),
            events: events.map((event) => ({
              eventId: decodeEventId(this.#options.uuid()),
              eventName: event.eventName,
              eventVersion: 1,
              correlationId: decodeCorrelationId(this.#options.uuid()),
              actor,
              occurredAt,
              payload: decodePayload(event.eventName, event.payload),
            })),
          }).events;
        }),
      );
    } catch {
      return "unavailable";
    }
    for (const envelope of committed) this.#apply(envelope);
    return "appended";
  }

  /**
   * Rebuilds the store from the journal without decoding what cannot change
   * it. One pass reads, in journal order, every rule, proposal, learn-mode,
   * launch start and settlement record, and every launch's taint mark; a
   * second reads the decision batches of the launches still open, the only
   * ones recovery summarizes. A settled launch's batches, and outside content
   * that is not a launch's mark, are never read. Each aggregate's version is
   * then taken from the journal, as a replay of every row would leave it.
   */
  #hydrate(): void {
    const names = TOOL_EGRESS_EVENT_NAMES;
    // Proposals close when a rule for their host is granted after them, and a
    // Project rule lives on another aggregate, so both are read in journal order.
    const streams = [
      new ReplayStream(this.#options.journal, {
        aggregateType: TOOL_EGRESS_THREAD_AGGREGATE,
        exceptEventName: names.decisionsRecorded,
      }),
      new ReplayStream(this.#options.journal, { aggregateType: TOOL_EGRESS_PROJECT_AGGREGATE }),
      new ReplayStream(this.#options.journal, {
        aggregateType: THREAD_EXTERNAL_CONTENT_AGGREGATE,
        eventName: THREAD_EXTERNAL_CONTENT_EVENT_NAMES.ingested,
        payloadPrefix: { path: "contentReference", prefix: LAUNCH_TAINT_REFERENCE_PREFIX },
      }),
    ];
    for (;;) {
      let next: ReplayStream | undefined;
      for (const stream of streams) {
        const head = stream.peek();
        if (head === undefined) continue;
        const nextHead = next?.peek();
        if (nextHead === undefined || head.globalSequence < nextHead.globalSequence) next = stream;
      }
      const envelope = next?.take();
      if (envelope === undefined) break;
      this.#replay(envelope);
    }
    // A batch only adds to a launch still open since its latest start, so the
    // batches before that start, and every settled launch's, change nothing.
    for (const [launchId, open] of this.#openLaunches) {
      const batches = new ReplayStream(
        this.#options.journal,
        {
          aggregateType: TOOL_EGRESS_THREAD_AGGREGATE,
          eventName: names.decisionsRecorded,
          payloadPrefix: { path: "launch.launchId", prefix: launchId },
        },
        open.startSequence,
      );
      for (let envelope = batches.take(); envelope !== undefined; envelope = batches.take()) {
        if (envelope.eventName !== names.decisionsRecorded) continue;
        const launch = (
          envelope.payload as { readonly launch?: { readonly launchId?: unknown } } | null
        )?.launch;
        if (launch?.launchId === launchId) this.#replay(envelope);
      }
    }
    for (const { aggregateId, aggregateVersion } of this.#options.journal.aggregateVersions(
      TOOL_EGRESS_THREAD_AGGREGATE,
    )) {
      this.#versions.set(aggregateKey(TOOL_EGRESS_THREAD_AGGREGATE, aggregateId), aggregateVersion);
    }
    this.#sweepExpiredRules(true);
  }

  #replay(envelope: EventEnvelope): void {
    try {
      this.#apply(envelope);
    } catch {
      // A record that no longer decodes grants nothing; the rest still replay.
      this.#versions.set(
        aggregateKey(envelope.aggregateType, String(envelope.aggregateId)),
        envelope.aggregateVersion,
      );
      this.#failClosedOnUnreadable(envelope);
    }
  }

  #apply(envelope: EventEnvelope): void {
    if (envelope.aggregateType === THREAD_EXTERNAL_CONTENT_AGGREGATE) {
      this.#applyTaint(envelope);
      return;
    }
    this.#versions.set(
      aggregateKey(envelope.aggregateType, String(envelope.aggregateId)),
      envelope.aggregateVersion,
    );
    const names = TOOL_EGRESS_EVENT_NAMES;
    const payload = decodePayload(envelope.eventName, envelope.payload);
    const at = envelope.occurredAt;
    switch (envelope.eventName) {
      case names.threadRuleGranted: {
        const granted = payload as ThreadEgressRuleGrantedPayload;
        const threadId = granted.threadId;
        rulesOf(this.#threadRules, String(threadId)).set(String(granted.ruleId), {
          ruleId: granted.ruleId,
          host: granted.host,
          port: granted.port,
          scope:
            granted.scope.kind === "call"
              ? { kind: "call", threadId, launchId: granted.scope.launchId }
              : { kind: "thread", threadId },
          expiresAt: granted.expiresAt,
          grantedAt: at,
          grantedBy: granted.principal.kind,
        });
        this.#closeAnswered(String(threadId), granted.host, granted.port);
        return;
      }
      case names.threadRuleRevoked: {
        const revoked = payload as ThreadEgressRuleRevokedPayload;
        this.#threadRules.get(String(revoked.threadId))?.delete(String(revoked.ruleId));
        return;
      }
      case names.projectRuleGranted: {
        const granted = payload as ProjectEgressRuleGrantedPayload;
        rulesOf(this.#projectRules, String(granted.projectId)).set(String(granted.ruleId), {
          ruleId: granted.ruleId,
          host: granted.host,
          port: granted.port,
          scope: { kind: "project", projectId: granted.projectId },
          expiresAt: granted.expiresAt,
          grantedAt: at,
          grantedBy: granted.principal.kind,
        });
        this.#closeAnswered(String(granted.threadId), granted.host, granted.port);
        return;
      }
      case names.projectRuleRevoked: {
        const revoked = payload as ProjectEgressRuleRevokedPayload;
        this.#projectRules.get(String(revoked.projectId))?.delete(String(revoked.ruleId));
        return;
      }
      case names.proposalRaised: {
        const raised = payload as ThreadEgressProposalRaisedPayload;
        const open = this.#proposals.get(String(raised.threadId)) ?? new Map();
        if (raised.threadTainted) {
          for (const [id, { payload: earlier }] of open) {
            if (earlier.host === raised.host && earlier.port === raised.port) open.delete(id);
          }
          const key = hostKey(raised.host, raised.port);
          setOf(this.#taintedHostsByThread, String(raised.threadId)).add(key);
          setOf(this.#taintedHostsByProject, String(raised.launch.projectId)).add(key);
        }
        open.set(String(raised.proposalId), { payload: raised, raisedAt: at });
        this.#proposals.set(String(raised.threadId), open);
        return;
      }
      case names.proposalDeclined: {
        const declined = payload as ThreadEgressProposalDeclinedPayload;
        const open = this.#proposals.get(String(declined.threadId));
        for (const id of declined.proposalIds) open?.delete(String(id));
        return;
      }
      case names.learnModeSet: {
        const set = payload as ThreadEgressLearnModeSetPayload;
        if (set.enabled) this.#learnModeOff.delete(String(set.threadId));
        else this.#learnModeOff.add(String(set.threadId));
        return;
      }
      case names.launchStarted: {
        const started = payload as ThreadEgressLaunchStartedPayload;
        this.#openLaunches.set(String(started.launch.launchId), {
          launch: started.launch,
          startSequence: envelope.globalSequence,
          entries: new Map(),
        });
        return;
      }
      case names.decisionsRecorded: {
        const recorded = payload as ThreadEgressDecisionsRecordedPayload;
        const open = this.#openLaunches.get(String(recorded.launch.launchId));
        // Each entry carries its running totals, so the latest one stands.
        for (const entry of recorded.entries) open?.entries.set(entryKey(entry), entry);
        return;
      }
      case names.launchSummarized: {
        const summary = payload as ThreadEgressLaunchSummarizedPayload;
        const launchId = String(summary.launch.launchId);
        this.#openLaunches.delete(launchId);
        this.#retireCallRules(summary.launch);
        if (
          summary.bytesReceived > 0 &&
          !this.#live.has(launchId) &&
          !this.#markedLaunches.has(launchId)
        ) {
          this.#unmarkedLaunches.set(launchId, String(summary.launch.threadId));
        }
        return;
      }
      case names.launchIncomplete: {
        const incomplete = payload as ThreadEgressLaunchIncompletePayload;
        const launchId = String(incomplete.launch.launchId);
        this.#openLaunches.delete(launchId);
        this.#retireCallRules(incomplete.launch);
        // The tail is unknown, so whatever the batches show, the launch may
        // have received bytes after them.
        if (!this.#markedLaunches.has(launchId)) {
          this.#unmarkedLaunches.set(launchId, String(incomplete.launch.threadId));
        }
        return;
      }
    }
  }

  /**
   * A revocation that no longer decodes still revokes: its rule is dropped
   * when its id can be read, and otherwise the whole aggregate's rules stop
   * applying and it takes no more grants.
   */
  #failClosedOnUnreadable(envelope: EventEnvelope): void {
    const names = TOOL_EGRESS_EVENT_NAMES;
    const rules =
      envelope.eventName === names.threadRuleRevoked
        ? this.#threadRules
        : envelope.eventName === names.projectRuleRevoked
          ? this.#projectRules
          : undefined;
    if (rules === undefined) return;
    const aggregateId = String(envelope.aggregateId);
    const ruleId = (envelope.payload as { readonly ruleId?: unknown } | null)?.ruleId;
    if (typeof ruleId === "string" && ruleId.length > 0) {
      rules.get(aggregateId)?.delete(ruleId);
      return;
    }
    rules.delete(aggregateId);
    this.#unreadableAggregates.add(aggregateKey(envelope.aggregateType, aggregateId));
  }

  /** Notes, while replaying, which launches the journal already shows marking their thread. */
  #applyTaint(envelope: EventEnvelope): void {
    if (envelope.eventName !== THREAD_EXTERNAL_CONTENT_EVENT_NAMES.ingested) return;
    const reference = (envelope.payload as { readonly contentReference?: unknown })
      .contentReference;
    if (typeof reference !== "string" || !reference.startsWith(LAUNCH_TAINT_REFERENCE_PREFIX)) {
      return;
    }
    const launchId = reference.slice(LAUNCH_TAINT_REFERENCE_PREFIX.length);
    this.#markedLaunches.add(launchId);
    this.#unmarkedLaunches.delete(launchId);
  }

  /**
   * A `call` rule is its launch's alone, so it ends when the launch settles:
   * it leaves the lists and stops counting against the thread's limit.
   */
  #retireCallRules(launch: ToolEgressLaunch): void {
    const rules = this.#threadRules.get(String(launch.parentThreadId ?? launch.threadId));
    if (rules === undefined) return;
    for (const [ruleId, rule] of rules) {
      if (rule.scope.kind === "call" && String(rule.scope.launchId) === String(launch.launchId)) {
        rules.delete(ruleId);
      }
    }
  }

  /** A rule granted for a proposal's host and port answers it. */
  #closeAnswered(threadId: string, host: string, port: number): void {
    const open = this.#proposals.get(threadId);
    if (open === undefined) return;
    for (const [id, { payload }] of open) {
      if (payload.host === host && payload.port === port) open.delete(id);
    }
  }
}

type ReplayCursor = Omit<Parameters<Journal["replayAggregateType"]>[0], "afterSequence" | "limit">;

class ReplayStream {
  readonly #journal: Pick<Journal, "replayAggregateType">;
  readonly #cursor: ReplayCursor;
  #buffer: ReadonlyArray<EventEnvelope> = [];
  #index = 0;
  #afterSequence: number;
  #done = false;

  constructor(
    journal: Pick<Journal, "replayAggregateType">,
    cursor: ReplayCursor,
    afterSequence = 0,
  ) {
    this.#journal = journal;
    this.#cursor = cursor;
    this.#afterSequence = afterSequence;
  }

  peek(): EventEnvelope | undefined {
    if (this.#index >= this.#buffer.length && !this.#done) {
      this.#buffer = this.#journal.replayAggregateType({
        ...this.#cursor,
        afterSequence: this.#afterSequence,
        limit: REPLAY_BATCH,
      });
      this.#index = 0;
      if (this.#buffer.length < REPLAY_BATCH) this.#done = true;
    }
    return this.#buffer[this.#index];
  }

  take(): EventEnvelope | undefined {
    const envelope = this.peek();
    if (envelope !== undefined) {
      this.#index += 1;
      this.#afterSequence = envelope.globalSequence;
    }
    return envelope;
  }
}

function decodePayload(eventName: string, payload: unknown): unknown {
  const schema = PAYLOADS[eventName];
  if (schema === undefined) throw new Error(`Not a tool egress event: ${eventName}`);
  return Schema.decodeUnknownSync(schema)(payload);
}

function rulesOf(map: Map<string, Map<string, StoredRule>>, key: string): Map<string, StoredRule> {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = new Map<string, StoredRule>();
  map.set(key, created);
  return created;
}

function grantsRule(event: AppendEvent): boolean {
  return (
    event.eventName === TOOL_EGRESS_EVENT_NAMES.threadRuleGranted ||
    event.eventName === TOOL_EGRESS_EVENT_NAMES.projectRuleGranted
  );
}

function hostKey(host: string, port: number): string {
  return `${host} ${String(port)}`;
}

/** Whether a rule host, exact or `*.name`, covers a host a tainted launch asked for on its port. */
function matchesTaintedHost(
  tainted: ReadonlySet<string> | undefined,
  ruleHost: string,
  port: number,
): boolean {
  if (tainted === undefined) return false;
  for (const key of tainted) {
    const [host = "", taintedPort = ""] = key.split(" ");
    if (taintedPort !== String(port)) continue;
    if (ruleHost.startsWith("*.") ? host.endsWith(ruleHost.slice(1)) : host === ruleHost) {
      return true;
    }
  }
  return false;
}

function setOf(map: Map<string, Set<string>>, key: string): Set<string> {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  map.set(key, created);
  return created;
}

function aggregateKey(aggregateType: string, aggregateId: string): string {
  return `${aggregateType}:${aggregateId}`;
}

function entryKey(entry: ToolEgressDecisionEntry): string {
  return `${entry.decision} ${entry.decision === "refused" ? entry.reason : ""} ${entry.host} ${String(entry.port)}`;
}

function sum(values: ReadonlyArray<number>): number {
  return values.reduce((total, value) => total + value, 0);
}
