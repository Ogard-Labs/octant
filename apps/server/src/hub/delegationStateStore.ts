// What a host remembers about delegations: the ones it received from a peer
// (which thread each became here) and the ones it sent (where each child runs
// and whether its result is recorded). The journal records every change with
// its principal; this file is what a restart reads. It sits beside the hub
// state in the Octant data folder where only the person's account reads it, and
// a file that cannot be read back exactly is treated as no state.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DelegatedAuthority,
  DelegatingThreadReference,
  DelegationChildState,
  DelegationRequestId,
  DelegationResult,
  HubMemberId,
  PeerDelegationMode,
  ProjectId,
  UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";

const SUBDIR = "hub";
const FILE = "delegations.json";
const strict = { parseOptions: { onExcessProperty: "error" as const } };
/** The newest entries a host keeps of each kind; a person's own devices delegate rarely. */
const MAX_REMEMBERED = 1_024;

/** A delegation this spoke accepted from a peer, and the thread it became here. */
export const ReceivedDelegation = Schema.Struct({
  requestId: DelegationRequestId,
  senderMemberId: HubMemberId,
  projectId: ProjectId,
  delegatedFrom: DelegatingThreadReference,
  threadId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  /** The turn that carries the task; a follow-up a person runs on the thread is a different turn. */
  turnId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  authority: DelegatedAuthority,
  receivedAt: UtcTimestamp,
}).annotations(strict);
export type ReceivedDelegation = typeof ReceivedDelegation.Type;

/** A delegation this spoke sent for one of its own threads. */
export const SentDelegation = Schema.Struct({
  requestId: DelegationRequestId,
  targetMemberId: HubMemberId,
  projectId: ProjectId,
  parent: Schema.Struct({
    mode: PeerDelegationMode,
    threadId: Schema.UUID,
  }).annotations(strict),
  authority: DelegatedAuthority,
  /** The child's state as the target last reported it. */
  state: DelegationChildState,
  /** Set once the result was recorded on the parent thread; a result is recorded once. */
  resultRecorded: Schema.optional(Schema.Literal(true)),
  /**
   * What the target returned, kept so a read after the background poll recorded
   * it still hands the parent thread the text; the journal holds only the mark.
   */
  result: Schema.optional(DelegationResult),
  sentAt: UtcTimestamp,
}).annotations(strict);
export type SentDelegation = typeof SentDelegation.Type;

export const DelegationState = Schema.Struct({
  received: Schema.Array(ReceivedDelegation),
  sent: Schema.Array(SentDelegation),
}).annotations(strict);
export type DelegationState = typeof DelegationState.Type;

export const EMPTY_DELEGATION_STATE: DelegationState = { received: [], sent: [] };

const decodeState = Schema.decodeUnknownSync(DelegationState);

export interface DelegationStatePort {
  readonly load: () => DelegationState;
  readonly save: (state: DelegationState) => void;
}

export function createDelegationStateStore(dataDirectory: string): DelegationStatePort {
  const directory = join(dataDirectory, SUBDIR);
  const path = join(directory, FILE);
  return {
    load: () => {
      try {
        return decodeState(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return EMPTY_DELEGATION_STATE;
      }
    },
    save: (state) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const staging = `${path}.${process.pid}.tmp`;
      const kept: DelegationState = {
        received: state.received.slice(-MAX_REMEMBERED),
        sent: state.sent.slice(-MAX_REMEMBERED),
      };
      writeFileSync(staging, JSON.stringify(Schema.encodeSync(DelegationState)(kept)), {
        mode: 0o600,
      });
      chmodSync(staging, 0o600);
      renameSync(staging, path);
    },
  };
}
