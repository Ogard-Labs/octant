/**
 * The journaled record of a finished child's result the host steered into its
 * parent's running turn. A queued delivery is a turn of its own and its turn
 * carries the mark; a steered one entered a turn that was already running, so
 * without this record the person would never see the result in the thread.
 *
 * Each record is its own one-event aggregate: it never advances the parent
 * thread's or the running turn's version, which the turn's own writers check
 * against while the turn runs. Each mode's transcript read attaches the
 * records to the turn they name, so a replay or a rebuilt projection reads
 * the same cards.
 */
import {
  AggregateId,
  AggregateVersion,
  CorrelationId,
  decodeAgentResultSteered,
  EventId,
  MAX_AGENT_RESULT_STEERED_BODY_CHARACTERS,
  MAX_AGENT_RESULTS_STEERED_PER_TURN,
  type AgentResultSteered,
  type AgentResultSteeredIntoTurn,
  type AgentRun,
  type EventEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { agentRunResultGeneration } from "./agentResultDeliveryBatch";

export const AGENT_RESULT_STEERED = "agent.result-steered@1";
export const AGENT_RESULT_STEERING_AGGREGATE_TYPE = "agent-result-steering";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const decodeAggregateVersion = Schema.decodeUnknownSync(AggregateVersion);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);

/** Journal reads stop here; a thread steered into this often lists no more. */
const MAX_STEERED_RECORDS_PER_THREAD = 1_000;

/**
 * Journals that `runs` were steered into the parent's turn named by `turnKey`.
 * Host-authored: the delivery is owed by the host, never by a window.
 */
export function journalAgentResultSteered(
  journal: Pick<Journal, "append">,
  input: {
    readonly runs: ReadonlyArray<AgentRun>;
    readonly body: string;
    readonly turnKey: string;
    readonly steeredAt: string;
    readonly uuid: () => string;
    readonly actorId: string;
  },
): AgentResultSteered {
  const first = input.runs[0];
  if (first === undefined) throw new Error("A steered delivery names at least one run.");
  const record = decodeAgentResultSteered({
    kind: "agent-result-steered",
    threadId: first.parentThreadId,
    turnKey: input.turnKey,
    delivery: {
      kind: "agent-result",
      runId: first.id,
      runIds: input.runs.map((run) => run.id),
      runGenerations: input.runs.map((run) => ({
        runId: run.id,
        generation: agentRunResultGeneration(run),
      })),
    },
    body: input.body.slice(0, MAX_AGENT_RESULT_STEERED_BODY_CHARACTERS),
    steeredAt: input.steeredAt,
  });
  journal.append({
    aggregate: {
      aggregateType: AGENT_RESULT_STEERING_AGGREGATE_TYPE,
      aggregateId: decodeAggregateId(input.uuid()),
    },
    expectedVersion: decodeAggregateVersion(0),
    events: [
      {
        eventId: decodeEventId(input.uuid()),
        eventName: AGENT_RESULT_STEERED,
        eventVersion: 1,
        correlationId: decodeCorrelationId(input.uuid()),
        actor: { kind: "system", actorId: input.actorId },
        occurredAt: record.steeredAt,
        payload: record,
      },
    ],
  });
  return record;
}

/** The record a journal row holds, or undefined for any other row. */
export function agentResultSteeredFrom(envelope: EventEnvelope): AgentResultSteered | undefined {
  if (envelope.eventName !== AGENT_RESULT_STEERED || envelope.eventVersion !== 1) return undefined;
  try {
    return decodeAgentResultSteered(envelope.payload);
  } catch {
    return undefined;
  }
}

/** Every steered delivery journaled for one parent thread, in journal order. */
export function readAgentResultsSteered(
  journal: Pick<Journal, "replayAggregateTypeForThread">,
  threadId: string,
): ReadonlyArray<AgentResultSteered> {
  const records: AgentResultSteered[] = [];
  let afterSequence = 0;
  while (records.length < MAX_STEERED_RECORDS_PER_THREAD) {
    const batch = journal.replayAggregateTypeForThread({
      aggregateType: AGENT_RESULT_STEERING_AGGREGATE_TYPE,
      threadId,
      afterSequence,
      limit: 200,
    });
    for (const envelope of batch) {
      afterSequence = envelope.globalSequence;
      const record = agentResultSteeredFrom(envelope);
      if (record !== undefined) records.push(record);
    }
    if (batch.length < 200) break;
  }
  return records;
}

/**
 * Adds one steered delivery to what a turn already carries. A record naming a
 * run generation the turn already shows is the same delivery read again, so
 * replay and a rebuild leave the turn as it was.
 */
export function withAgentResultSteered(
  existing: ReadonlyArray<AgentResultSteeredIntoTurn> | undefined,
  record: AgentResultSteered,
): ReadonlyArray<AgentResultSteeredIntoTurn> {
  const current = existing ?? [];
  const members = (entry: AgentResultSteeredIntoTurn) =>
    (
      entry.delivery.runGenerations ??
      (entry.delivery.runIds ?? [entry.delivery.runId]).map((runId) => ({ runId, generation: 1 }))
    ).map((member) => `${String(member.runId)}:${member.generation}`);
  const shown = new Set(current.flatMap(members));
  if (members(record).some((member) => shown.has(member))) return current;
  if (current.length >= MAX_AGENT_RESULTS_STEERED_PER_TURN) return current;
  return [
    ...current,
    { delivery: record.delivery, body: record.body, steeredAt: record.steeredAt },
  ];
}

/** The steered deliveries one turn carries, folded from the thread's records. */
export function agentResultsSteeredInto(
  records: ReadonlyArray<AgentResultSteered>,
  turnKey: string,
): ReadonlyArray<AgentResultSteeredIntoTurn> {
  return records
    .filter((record) => record.turnKey === turnKey)
    .reduce<ReadonlyArray<AgentResultSteeredIntoTurn>>(withAgentResultSteered, []);
}
