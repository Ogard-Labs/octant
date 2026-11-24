import {
  ProjectMemoryProposalDecisionResult,
  ProjectMemoryProposalList,
  decodeHostAnswer,
  type ProjectMemoryProposal,
} from "@octant/contracts";
import {
  RoutineProposalDecisionResult,
  RoutineProposalList,
  type RoutineAgentRequest,
} from "@octant/contracts/automation";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const MEMORY_PROPOSALS_PATH = "/api/projects/memory/proposals";
const MEMORY_PROPOSAL_DECIDE_PATH = "/api/projects/memory/proposals/decide";
const ROUTINE_PROPOSALS_PATH = "/api/automations/proposals";
const ROUTINE_PROPOSAL_DECIDE_PATH = "/api/automations/proposals/decide";

/**
 * What came of a person's answer to a memory or routine proposal. Every
 * answer the host takes removes the proposal from its list, whatever came of
 * it, except `unrecorded`: the host could not journal the answer, so the
 * proposal still waits and may be answered again. `refused` is a host that
 * would not take an answer from this session (only a device the host's own
 * person paired may answer).
 */
export type MobileProposalAnswer =
  | { readonly status: "answered" }
  | { readonly status: "not-applied"; readonly message: string }
  | { readonly status: "unrecorded"; readonly message: string }
  | { readonly status: "gone" }
  | { readonly status: "refused" };

export type MobileProposalDecision = "confirm" | "decline";

async function listed(
  transport: MobileRemoteTransport,
  path: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await transport.authenticatedFetch({
    method: "GET",
    path,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error(`Listing proposals failed with ${response.status}.`);
  return response.json();
}

async function decided(
  transport: MobileRemoteTransport,
  path: string,
  body: { readonly proposalId: string; readonly decision: MobileProposalDecision },
): Promise<unknown> {
  const response = await transport.authenticatedFetch({
    method: "POST",
    path,
    body: JSON.stringify(body),
    contentType: "application/json",
  });
  if (!response.ok) return undefined;
  return response.json();
}

/**
 * The Project memory changes this paired device's own turns asked for in one
 * thread. The host lists only those this session may answer. A refused read
 * throws, so a caller can tell "nothing is waiting" from "could not ask".
 */
export async function listMobileMemoryProposals(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyArray<ProjectMemoryProposal>> {
  const value = await listed(input.transport, MEMORY_PROPOSALS_PATH, input.signal);
  return decodeHostAnswer(ProjectMemoryProposalList)(value).proposals.filter(
    (proposal) => String(proposal.threadId) === input.threadId,
  );
}

export async function decideMobileMemoryProposal(input: {
  readonly transport: MobileRemoteTransport;
  readonly proposalId: string;
  readonly decision: MobileProposalDecision;
}): Promise<MobileProposalAnswer> {
  const value = await decided(input.transport, MEMORY_PROPOSAL_DECIDE_PATH, {
    proposalId: input.proposalId,
    decision: input.decision,
  });
  if (value === undefined) return { status: "refused" };
  const result = decodeHostAnswer(ProjectMemoryProposalDecisionResult)(value);
  switch (result.kind) {
    case "project-memory-proposal-confirmed":
    case "project-memory-proposal-declined":
      return { status: "answered" };
    case "project-memory-proposal-gone":
      return { status: "gone" };
    case "project-memory-proposal-not-applied":
      return { status: "not-applied", message: result.message };
  }
}

/** The routines, and pause or archive requests, this device's own turns raised in one thread. */
export async function listMobileRoutineProposals(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyArray<RoutineAgentRequest>> {
  const value = await listed(input.transport, ROUTINE_PROPOSALS_PATH, input.signal);
  return decodeHostAnswer(RoutineProposalList)(value).proposals.filter(
    (proposal) => String(proposal.threadId) === input.threadId,
  );
}

export async function decideMobileRoutineProposal(input: {
  readonly transport: MobileRemoteTransport;
  readonly proposalId: string;
  readonly decision: MobileProposalDecision;
}): Promise<MobileProposalAnswer> {
  const value = await decided(input.transport, ROUTINE_PROPOSAL_DECIDE_PATH, {
    proposalId: input.proposalId,
    decision: input.decision,
  });
  if (value === undefined) return { status: "refused" };
  const result = decodeHostAnswer(RoutineProposalDecisionResult)(value);
  switch (result.kind) {
    case "routine-proposal-confirmed":
    case "routine-proposal-declined":
      return { status: "answered" };
    case "routine-proposal-gone":
      return { status: "gone" };
    case "routine-proposal-answer-unrecorded":
      return { status: "unrecorded", message: result.message };
    case "automation-command-failed":
      return { status: "not-applied", message: result.message };
  }
}
