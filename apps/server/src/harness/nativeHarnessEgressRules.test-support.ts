import { Schema } from "effect";
import {
  EventActor,
  MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES,
  TOOL_EGRESS_EVENT_NAMES,
  TOOL_EGRESS_PROJECT_AGGREGATE,
  TOOL_EGRESS_THREAD_AGGREGATE,
  type ToolEgressDecisionEntry,
} from "@octant/contracts";
import { ExternalContentClearStore } from "../context/externalContentClearStore";
import { ExternalContentIngestionStore } from "../context/externalContentIngestionStore";
import type { Journal } from "../persistence/journal";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { toolEgressLaunchTaintReference } from "./nativeHarnessEgressRules";

/*
 * Writes a long, seeded history of harness tool egress straight into a
 * journal: rules granted, revoked, and expired at every lifetime, proposals
 * raised and declined, learn mode switched, and launches that ran, recorded
 * decision batches, and settled every way the store must survive (summarized
 * with and without bytes, marked before or after the summary or not at all,
 * marked incomplete, or left open by a crash). The same seed writes the same
 * history, so a restart can be compared with a full replay of it.
 */

const decodeActor = Schema.decodeUnknownSync(EventActor);

export const seededRequestHosts = [
  "registry.example.com",
  "pypi.example.com",
  "a.example.org",
  "b.example.org",
  "cdn.example.net",
  "files.example.net",
  "api.example.io",
] as const;

const ruleHosts = [...seededRequestHosts, "*.example.org", "*.example.net"] as const;
const threadLifetimesMs = [3_600_000, 8 * 3_600_000, 7 * 86_400_000];
const projectLifetimesMs = [7 * 86_400_000, 30 * 86_400_000];

export interface SeededThread {
  readonly threadId: string;
  readonly projectId: string;
  /** The thread a child's rules and proposals live on. */
  readonly parentThreadId?: string;
}

export interface EgressSeedOptions {
  readonly journal: Journal;
  readonly connection: SqliteConnection;
  readonly seed: number;
  readonly threads: ReadonlyArray<SeededThread>;
  readonly launches: number;
  readonly batchesPerLaunch: number;
  /** The history ends a few minutes before this instant. */
  readonly endAt: number;
  /** Launches left open by a crash; the last one is always among the most recent. */
  readonly openLaunches: number;
  /** Ingestions of outside content unrelated to egress, per launch. */
  readonly unrelatedIngestions: number;
  /** Launch ids recorded in odd orders: restarted, batched after settling, settled unstarted. */
  readonly oddOrders: boolean;
  /**
   * A person clears every thread's mark once the history ends, so only the
   * journal's launch marks keep a launch from tainting its thread again.
   */
  readonly clearedAtEnd: boolean;
}

/** A launch as the journal records it, before its ids are decoded. */
interface SeededLaunch {
  readonly launchId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
  readonly toolCallId: string;
}

export interface EgressSeed {
  readonly events: number;
  readonly decisionBatches: number;
  /** Decision batches of launches still open when the history ends. */
  readonly openDecisionBatches: number;
}

export function seedEgressJournal(options: EgressSeedOptions): EgressSeed {
  const random = mulberry32(options.seed);
  const pick = <T>(values: ReadonlyArray<T>): T => {
    const value = values[Math.floor(random() * values.length)];
    if (value === undefined) throw new Error("nothing to pick from");
    return value;
  };
  const uuid = () => seededUuid(random);
  const stepMs = 10 * 60_000;
  let at = options.endAt - options.launches * stepMs - 30 * 86_400_000;
  const clock = () => new Date(at).toISOString();
  const advance = () => {
    at = Math.min(at + Math.floor(random() * 2 * stepMs), options.endAt - 5 * 60_000);
  };
  const actor = decodeActor({ kind: "system", actorId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
  const ingestion = new ExternalContentIngestionStore({
    journal: options.journal,
    connection: options.connection,
    uuid,
    clock,
    actor,
  });
  const clears = new ExternalContentClearStore({
    journal: options.journal,
    connection: options.connection,
    uuid,
    clock,
    actor: decodeActor({ kind: "local-user", actorId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
  });
  const versions = new Map<string, number>();
  let events = 0;
  let decisionBatches = 0;
  const append = (
    aggregateType: string,
    aggregateId: string,
    eventName: string,
    payload: object,
  ) => {
    const key = `${aggregateType}:${aggregateId}`;
    const version = versions.get(key) ?? 0;
    options.journal.append({
      aggregate: { aggregateType, aggregateId },
      expectedVersion: version,
      events: [
        {
          eventId: uuid(),
          eventName,
          eventVersion: 1,
          correlationId: uuid(),
          actor,
          occurredAt: clock(),
          payload,
        },
      ],
    });
    versions.set(key, version + 1);
    events += 1;
  };
  const markLaunch = (threadId: string, launchId: string) => {
    ingestion.record({
      threadId,
      provenance: { origin: "external-content", sourceLabel: "tool-egress" },
      contentReference: toolEgressLaunchTaintReference(launchId),
      correlationId: launchId,
      authorized: true,
    });
    events += 1;
  };

  const ruleThreads = options.threads.filter((thread) => thread.parentThreadId === undefined);
  const granted: Array<{
    readonly ruleId: string;
    readonly thread: SeededThread;
    project: boolean;
  }> = [];
  const proposals = new Map<string, string[]>();
  const settled: SeededLaunch[] = [];
  const entriesFor = (count: number): ToolEgressDecisionEntry[] =>
    Array.from({ length: count }, (_, index) =>
      random() < 0.6
        ? {
            host: `${String(index)}.${pick(seededRequestHosts)}`,
            port: 443,
            decision: "allowed",
            requests: 1 + Math.floor(random() * 20),
            bytesSent: Math.floor(random() * 5_000),
            bytesReceived: Math.floor(random() * 500_000),
          }
        : {
            host: `${String(index)}.${pick(seededRequestHosts)}`,
            port: 443,
            decision: "refused",
            reason: pick(["no-rule", "expired", "private-destination"] as const),
            requests: 1 + Math.floor(random() * 4),
          },
    );

  const grantThreadRule = (
    thread: SeededThread,
    scope: object,
    principal: object,
    tainted: boolean,
  ) => {
    const ruleId = uuid();
    append(
      TOOL_EGRESS_THREAD_AGGREGATE,
      thread.threadId,
      TOOL_EGRESS_EVENT_NAMES.threadRuleGranted,
      {
        ruleId,
        threadId: thread.threadId,
        host: pick(ruleHosts),
        port: random() < 0.9 ? 443 : 80,
        scope,
        expiresAt: new Date(at + pick(threadLifetimesMs)).toISOString(),
        principal,
        approvalId: uuid(),
        threadTainted: tainted,
      },
    );
    granted.push({ ruleId, thread, project: false });
  };

  const between = () => {
    const thread = pick(ruleThreads);
    const roll = random();
    if (roll < 0.15) {
      grantThreadRule(thread, { kind: "thread" }, { kind: "local-window" }, false);
    } else if (roll < 0.2) {
      const ruleId = uuid();
      append(
        TOOL_EGRESS_PROJECT_AGGREGATE,
        thread.projectId,
        TOOL_EGRESS_EVENT_NAMES.projectRuleGranted,
        {
          ruleId,
          projectId: thread.projectId,
          threadId: thread.threadId,
          host: pick(ruleHosts),
          port: 443,
          expiresAt: new Date(at + pick(projectLifetimesMs)).toISOString(),
          principal: { kind: "local-window" },
          approvalId: uuid(),
          threadTainted: false,
        },
      );
      granted.push({ ruleId, thread, project: true });
    } else if (roll < 0.26 && granted.length > 0) {
      const rule = pick(granted);
      if (rule.project) {
        append(
          TOOL_EGRESS_PROJECT_AGGREGATE,
          rule.thread.projectId,
          TOOL_EGRESS_EVENT_NAMES.projectRuleRevoked,
          {
            ruleId: rule.ruleId,
            projectId: rule.thread.projectId,
            principal: { kind: "local-window" },
          },
        );
      } else {
        append(
          TOOL_EGRESS_THREAD_AGGREGATE,
          rule.thread.threadId,
          TOOL_EGRESS_EVENT_NAMES.threadRuleRevoked,
          {
            ruleId: rule.ruleId,
            threadId: rule.thread.threadId,
            principal: { kind: "local-window" },
            threadTainted: random() < 0.3,
          },
        );
      }
    } else if (roll < 0.29) {
      append(TOOL_EGRESS_THREAD_AGGREGATE, thread.threadId, TOOL_EGRESS_EVENT_NAMES.learnModeSet, {
        threadId: thread.threadId,
        enabled: random() < 0.7,
        principal: { kind: "local-window" },
      });
    } else if (roll < 0.34) {
      const open = proposals.get(thread.threadId) ?? [];
      if (open.length > 0) {
        const declined = open.splice(0, 1 + Math.floor(random() * Math.min(open.length, 3)));
        append(
          TOOL_EGRESS_THREAD_AGGREGATE,
          thread.threadId,
          TOOL_EGRESS_EVENT_NAMES.proposalDeclined,
          {
            threadId: thread.threadId,
            proposalIds: declined,
            principal: { kind: "local-window" },
            threadTainted: random() < 0.3,
          },
        );
      }
    } else if (roll < 0.36 && settled.length > 0) {
      // A call rule for a launch that has already settled stays until it expires.
      const launch = pick(settled);
      const owner = options.threads.find(
        (candidate) => candidate.threadId === (launch.parentThreadId ?? launch.threadId),
      );
      if (owner !== undefined) {
        grantThreadRule(
          owner,
          { kind: "call", launchId: launch.launchId },
          { kind: "local-window" },
          random() < 0.5,
        );
      }
    } else if (roll < 0.37) {
      const cleared = clears.read(thread.threadId);
      clears.clear({
        threadId: thread.threadId,
        windowId: uuid(),
        expectedVersion: cleared.version,
        principal: "local-window",
        turn: "idle",
      });
    }
  };

  const openFrom = options.launches - options.openLaunches;
  let openDecisionBatches = 0;
  for (let index = 0; index < options.launches; index += 1) {
    advance();
    between();
    for (let noise = 0; noise < options.unrelatedIngestions; noise += 1) {
      ingestion.record({
        threadId: pick(options.threads).threadId,
        provenance: { origin: "external-content", sourceLabel: "web-fetch" },
        contentReference: `page-${uuid()}`,
        correlationId: uuid(),
        authorized: true,
      });
      events += 1;
    }
    const thread = pick(options.threads);
    const launch: SeededLaunch = {
      launchId: uuid(),
      threadId: thread.threadId,
      projectId: thread.projectId,
      ...(thread.parentThreadId === undefined ? {} : { parentThreadId: thread.parentThreadId }),
      toolCallId: "harness-bash-call",
    };
    const ruleOwner =
      options.threads.find((candidate) => candidate.threadId === thread.parentThreadId) ?? thread;
    if (random() < 0.2) {
      const reviewer = random() < 0.5;
      grantThreadRule(
        ruleOwner,
        { kind: "call", launchId: launch.launchId },
        reviewer ? { kind: "reviewer" } : { kind: "local-window" },
        !reviewer && random() < 0.5,
      );
    }
    const unstarted = options.oddOrders && random() < 0.02;
    if (!unstarted) {
      append(TOOL_EGRESS_THREAD_AGGREGATE, thread.threadId, TOOL_EGRESS_EVENT_NAMES.launchStarted, {
        launch,
        startedAt: clock(),
        threadTainted: random() < 0.2,
      });
    }
    const open = index >= openFrom;
    const batches = Math.max(1, options.batchesPerLaunch + Math.floor(random() * 5) - 2);
    for (let batch = 0; batch < batches; batch += 1) {
      if (options.oddOrders && batch === 1 && random() < (open ? 0.5 : 0.05)) {
        // A second start for the same launch begins its records again.
        append(
          TOOL_EGRESS_THREAD_AGGREGATE,
          thread.threadId,
          TOOL_EGRESS_EVENT_NAMES.launchStarted,
          { launch, startedAt: clock(), threadTainted: false },
        );
      }
      append(
        TOOL_EGRESS_THREAD_AGGREGATE,
        thread.threadId,
        TOOL_EGRESS_EVENT_NAMES.decisionsRecorded,
        {
          launch,
          entries: entriesFor(1 + Math.floor(random() * MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES)),
          threadTainted: false,
        },
      );
      decisionBatches += 1;
      if (open) openDecisionBatches += 1;
    }
    if (open) continue;
    const bytesReceived = random() < 0.6 ? 1 + Math.floor(random() * 1_000_000) : 0;
    const ending = random();
    if (bytesReceived > 0 && ending < 0.05) markLaunch(thread.threadId, launch.launchId);
    if (ending < 0.9) {
      append(
        TOOL_EGRESS_THREAD_AGGREGATE,
        thread.threadId,
        TOOL_EGRESS_EVENT_NAMES.launchSummarized,
        {
          launch,
          endedAt: clock(),
          bytesSent: Math.floor(random() * 10_000),
          bytesReceived,
          malformedRequests: 0,
          entries: entriesFor(Math.floor(random() * 8)),
          truncated: false,
          threadTainted: random() < 0.2,
        },
      );
      if (bytesReceived > 0 && ending >= 0.05 && ending < 0.85) {
        markLaunch(thread.threadId, launch.launchId);
      }
    } else {
      append(
        TOOL_EGRESS_THREAD_AGGREGATE,
        thread.threadId,
        TOOL_EGRESS_EVENT_NAMES.launchIncomplete,
        {
          launch,
          recordedBytesSent: 0,
          recordedBytesReceived: 0,
          entries: [],
          truncated: false,
          tail: "unknown",
          threadTainted: false,
        },
      );
      if (ending < 0.95) markLaunch(thread.threadId, launch.launchId);
    }
    if (options.oddOrders && random() < 0.03) {
      // A batch that lands after its launch settled changes nothing.
      append(
        TOOL_EGRESS_THREAD_AGGREGATE,
        thread.threadId,
        TOOL_EGRESS_EVENT_NAMES.decisionsRecorded,
        { launch, entries: entriesFor(2), threadTainted: false },
      );
      decisionBatches += 1;
    }
    settled.push(launch);
    if (random() < 0.4) {
      const proposalId = uuid();
      const proposingThread = launch.parentThreadId ?? launch.threadId;
      append(
        TOOL_EGRESS_THREAD_AGGREGATE,
        proposingThread,
        TOOL_EGRESS_EVENT_NAMES.proposalRaised,
        {
          proposalId,
          threadId: proposingThread,
          launch,
          host: pick(seededRequestHosts),
          port: 443,
          reason: random() < 0.8 ? "no-rule" : "expired",
          attempts: 1 + Math.floor(random() * 3),
          threadTainted: random() < 0.3,
        },
      );
      const open = proposals.get(proposingThread) ?? [];
      open.push(proposalId);
      proposals.set(proposingThread, open);
    }
  }
  if (options.clearedAtEnd) {
    for (const { threadId } of options.threads) {
      clears.clear({
        threadId,
        windowId: uuid(),
        expectedVersion: clears.read(threadId).version,
        principal: "local-window",
        turn: "idle",
      });
    }
  }
  return { events, decisionBatches, openDecisionBatches };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seededUuid(random: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = "89ab"[Math.floor(random() * 4)] ?? "8";
  const text = hex.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
