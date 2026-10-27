/**
 * Journal events for SSH targets and the Code Projects bound to their
 * folders. Canonical: docs/design/remote-ssh-environments.md § Data placement
 * and lifecycle.
 *
 * The journal is the record of every registration, pinned key, attestation
 * result, and binding. The pin file the SSH client reads is written from it;
 * connection state is never journaled. An attestation is journaled as a digest
 * of the facts the executor reported and what this host decided from them, so
 * a refusal can be explained later without keeping the facts themselves.
 */

import { Schema } from "effect";
import { CodeTerminalId } from "./code";
import { UtcTimestamp } from "./events";
import { ProviderInstanceId } from "./providers";
import { ProjectTerminalPosture } from "./projectTerminals";
import { ProjectId } from "./projects";
import { WindowId } from "./shell";
import { SshRemoteProject, SshRemoteWorktree, SshRemoteWorktreeId } from "./sshRemoteProject";
import {
  SshConnectionId,
  SshPinnedHostKey,
  SshTarget,
  SshTargetId,
  SshTargetPostureAdmission,
} from "./sshTarget";
import {
  MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES,
  MAX_TOOL_EGRESS_SUMMARY_ENTRIES,
  ToolEgressDecisionEntry,
  ToolEgressLaunch,
} from "./toolEgress";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const SSH_TARGET_AGGREGATE = "ssh-target";
export const SSH_TARGET_EVENT_NAMES = {
  registered: "ssh-target.registered@1",
  repinned: "ssh-target.repinned@1",
  attested: "ssh-target.attested@1",
  removed: "ssh-target.removed@1",
} as const;

export const SSH_REMOTE_PROJECT_AGGREGATE = "ssh-remote-project";
export const SSH_REMOTE_PROJECT_EVENT_NAMES = {
  bound: "ssh-remote-project.bound@1",
} as const;

export const SshTargetRegistered = Schema.Struct({ target: SshTarget }).annotations(strict);
export type SshTargetRegistered = typeof SshTargetRegistered.Type;

export const SshTargetRepinned = Schema.Struct({
  targetId: SshTargetId,
  hostKey: SshPinnedHostKey,
}).annotations(strict);
export type SshTargetRepinned = typeof SshTargetRepinned.Type;

/** SHA-256 of the attestation facts as their schema encodes them, as lowercase hex. */
export const SshAttestationFactsDigest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
export type SshAttestationFactsDigest = typeof SshAttestationFactsDigest.Type;

/**
 * One connection's attestation: which connection, the digest of what its
 * executor reported, and the decision for each confined posture it covered.
 */
export const SshTargetAttested = Schema.Struct({
  targetId: SshTargetId,
  connectionId: SshConnectionId,
  factsDigest: SshAttestationFactsDigest,
  admission: Schema.Array(SshTargetPostureAdmission).pipe(Schema.maxItems(8)),
}).annotations(strict);
export type SshTargetAttested = typeof SshTargetAttested.Type;

export const SshTargetRemoved = Schema.Struct({ targetId: SshTargetId }).annotations(strict);
export type SshTargetRemoved = typeof SshTargetRemoved.Type;

export const SshRemoteProjectBound = Schema.Struct({
  project: SshRemoteProject,
}).annotations(strict);
export type SshRemoteProjectBound = typeof SshRemoteProjectBound.Type;

export const decodeSshTargetRegistered = Schema.decodeUnknownSync(SshTargetRegistered);
export const decodeSshTargetRepinned = Schema.decodeUnknownSync(SshTargetRepinned);
export const decodeSshTargetAttested = Schema.decodeUnknownSync(SshTargetAttested);
export const decodeSshTargetRemoved = Schema.decodeUnknownSync(SshTargetRemoved);
export const decodeSshRemoteProjectBound = Schema.decodeUnknownSync(SshRemoteProjectBound);

/**
 * Managed worktrees of remote-bound Projects. Each worktree is its own
 * aggregate: created once, removed at most once. The path is the canonical
 * folder the executor reported, the root every later request on it names.
 */
export const SSH_REMOTE_WORKTREE_AGGREGATE = "ssh-remote-worktree";
export const SSH_REMOTE_WORKTREE_EVENT_NAMES = {
  created: "ssh-remote-worktree.created@1",
  removed: "ssh-remote-worktree.removed@1",
} as const;

export const SshRemoteWorktreeCreated = Schema.Struct({
  worktree: SshRemoteWorktree,
  /** Provenance: the session whose executor created it. */
  connectionId: SshConnectionId,
}).annotations(strict);
export type SshRemoteWorktreeCreated = typeof SshRemoteWorktreeCreated.Type;

export const SshRemoteWorktreeRemoved = Schema.Struct({
  worktreeId: SshRemoteWorktreeId,
  connectionId: SshConnectionId,
}).annotations(strict);
export type SshRemoteWorktreeRemoved = typeof SshRemoteWorktreeRemoved.Type;

/**
 * Terminals a person opened on a remote-bound Project's target. As for a
 * local Project terminal, the record says who opened which shell where and
 * how it ended; its output is never part of any record.
 */
export const SSH_REMOTE_TERMINAL_AGGREGATE = "ssh-remote-terminal";
export const SSH_REMOTE_TERMINAL_EVENT_NAMES = {
  started: "ssh-remote-terminal.started@1",
  ended: "ssh-remote-terminal.ended@1",
} as const;

export const SshRemoteTerminalStarted = Schema.Struct({
  terminalId: CodeTerminalId,
  projectId: ProjectId,
  worktreeId: Schema.optional(SshRemoteWorktreeId),
  windowId: WindowId,
  /** Provenance: the target and the session the shell ran on. */
  targetId: SshTargetId,
  connectionId: SshConnectionId,
  posture: ProjectTerminalPosture,
}).annotations(strict);
export type SshRemoteTerminalStarted = typeof SshRemoteTerminalStarted.Type;

/** Why a remote terminal ended: as a local one does, or with its target's session. */
export const SshRemoteTerminalEndReason = Schema.Literal(
  "stopped",
  "exited",
  "target-disconnected",
  "host-restarted",
);
export type SshRemoteTerminalEndReason = typeof SshRemoteTerminalEndReason.Type;

export const SshRemoteTerminalEnded = Schema.Struct({
  terminalId: CodeTerminalId,
  reason: SshRemoteTerminalEndReason,
  exitCode: Schema.optional(Schema.Int),
}).annotations(strict);
export type SshRemoteTerminalEnded = typeof SshRemoteTerminalEnded.Type;

export const decodeSshRemoteWorktreeCreated = Schema.decodeUnknownSync(SshRemoteWorktreeCreated);
export const decodeSshRemoteWorktreeRemoved = Schema.decodeUnknownSync(SshRemoteWorktreeRemoved);
export const decodeSshRemoteTerminalStarted = Schema.decodeUnknownSync(SshRemoteTerminalStarted);
export const decodeSshRemoteTerminalEnded = Schema.decodeUnknownSync(SshRemoteTerminalEnded);

/**
 * The egress of a provider runtime placed on an SSH target, decided at a
 * proxy of its own on this host under the runtime rule (any public name; no
 * private, loopback, or link-local address). Each proxied launch is its own
 * aggregate, keyed by its launch id. The records are the harness proxy's
 * shapes without a thread's taint: a runtime's traffic is its own, as
 * locally, and taints no thread. They name hosts, ports, and counts, never
 * content.
 */
export const PROVIDER_RUNTIME_EGRESS_AGGREGATE = "provider-runtime-egress";
export const PROVIDER_RUNTIME_EGRESS_EVENT_NAMES = {
  launchStarted: "provider-runtime-egress.launch-started@1",
  decisionsRecorded: "provider-runtime-egress.decisions-recorded@1",
  launchSummarized: "provider-runtime-egress.launch-summarized@1",
} as const;

/** Whose runtime made the connections: the thread, the provider instance, and the target. */
export const ProviderRuntimeEgressLaunchStarted = Schema.Struct({
  launch: ToolEgressLaunch,
  providerInstanceId: ProviderInstanceId,
  targetId: SshTargetId,
  connectionId: SshConnectionId,
  startedAt: UtcTimestamp,
}).annotations(strict);
export type ProviderRuntimeEgressLaunchStarted = typeof ProviderRuntimeEgressLaunchStarted.Type;

export const ProviderRuntimeEgressDecisionsRecorded = Schema.Struct({
  launch: ToolEgressLaunch,
  entries: Schema.Array(ToolEgressDecisionEntry).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES),
  ),
}).annotations(strict);
export type ProviderRuntimeEgressDecisionsRecorded =
  typeof ProviderRuntimeEgressDecisionsRecorded.Type;

export const ProviderRuntimeEgressLaunchSummarized = Schema.Struct({
  launch: ToolEgressLaunch,
  endedAt: UtcTimestamp,
  bytesSent: Schema.Int.pipe(Schema.nonNegative()),
  bytesReceived: Schema.Int.pipe(Schema.nonNegative()),
  malformedRequests: Schema.Int.pipe(Schema.nonNegative()),
  entries: Schema.Array(ToolEgressDecisionEntry).pipe(
    Schema.maxItems(MAX_TOOL_EGRESS_SUMMARY_ENTRIES),
  ),
  truncated: Schema.Boolean,
}).annotations(strict);
export type ProviderRuntimeEgressLaunchSummarized =
  typeof ProviderRuntimeEgressLaunchSummarized.Type;
