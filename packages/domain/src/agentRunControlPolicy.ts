import type {
  AgentRun,
  AgentRunAuthority,
  AgentRunExecutionKind,
  AgentRunRole,
  AggregateVersion,
  OctantMode,
  ProviderCapabilitySupport,
} from "@octant/contracts";
import { defaultAgentRunAuthorityCeilingForMode } from "./agentRunAuthorityCeiling";
import { AgentRunPolicyRejected, clampAgentRunAuthorityAgainstLiveGrant } from "./agentRunPolicy";

export { AgentRunPolicyRejected };

const CHAT_ROLES = ["research"] as const satisfies ReadonlyArray<AgentRunRole>;
const WORK_ROLES = [
  "research",
  "implementation",
  "review",
] as const satisfies ReadonlyArray<AgentRunRole>;
const CODE_ROLES = ["implementation", "review"] as const satisfies ReadonlyArray<AgentRunRole>;

const NATIVE_EVIDENCE_KEYS = [
  "workspace",
  "authority",
  "observability",
  "cancellation",
  "steering",
  "recovery",
] as const;

export type AgentRunNativeEvidenceKey = (typeof NATIVE_EVIDENCE_KEYS)[number];

/**
 * Capability evidence the server must hold before a child may run
 * provider-native. Each field is a fact the host observed, never a client
 * claim: native is an optimization and is ineligible unless every guarantee
 * is true and the provider reports nativeChildAgents as supported.
 */
export interface AgentRunNativeCapabilityEvidence {
  readonly claimedNativeSupport: ProviderCapabilitySupport;
  readonly workspace: boolean;
  readonly authority: boolean;
  readonly observability: boolean;
  readonly cancellation: boolean;
  readonly steering: boolean;
  readonly recovery: boolean;
}

export interface AgentRunExecutionSelection {
  readonly selectedExecutionKind: AgentRunExecutionKind;
  readonly attemptedExecutionKind: AgentRunExecutionKind;
  readonly nativeFallbackReason?: string;
  readonly capabilityDegradations: ReadonlyArray<string>;
  readonly rejectedNativeReasons: ReadonlyArray<string>;
}

function reject(code: AgentRunPolicyRejected["code"], message: string): never {
  throw new AgentRunPolicyRejected(code, message);
}

function assertExpectedVersion(run: AgentRun, expectedVersion: AggregateVersion): void {
  if (run.version !== expectedVersion) {
    reject("stale-version", `Expected version ${expectedVersion}, got ${run.version}`);
  }
}

/**
 * Roles this parent mode may admit. Chat stays research-only. Work stays
 * inside the bound root. Code implementation and review require isolated
 * worktrees, so research is not offered there.
 */
export function allowedAgentRunRolesForMode(mode: OctantMode): ReadonlyArray<AgentRunRole> {
  switch (mode) {
    case "chat":
      return CHAT_ROLES;
    case "work":
      return WORK_ROLES;
    case "code":
      return CODE_ROLES;
  }
}

export function isAgentRunRoleAllowedForMode(mode: OctantMode, role: AgentRunRole): boolean {
  return allowedAgentRunRolesForMode(mode).some((allowed) => allowed === role);
}

export function assertAgentRunRoleAllowedForMode(mode: OctantMode, role: AgentRunRole): void {
  if (!isAgentRunRoleAllowedForMode(mode, role)) {
    reject(
      "unsupported-transition",
      mode === "chat"
        ? "Chat children are limited to the research role."
        : mode === "code"
          ? "Code children are limited to implementation or review roles."
          : "This parent mode cannot admit the requested child role.",
    );
  }
}

/**
 * The authority a child should request: the parent's live grant, clamped to
 * the mode ceiling. Callers never take a renderer-supplied authority.
 */
export function deriveAgentRunRequestedAuthority(input: {
  readonly mode: OctantMode;
  readonly liveParentGrant: AgentRunAuthority;
  readonly projectCeiling?: AgentRunAuthority;
  readonly globalCeiling?: AgentRunAuthority;
}): AgentRunAuthority {
  return clampAgentRunAuthorityAgainstLiveGrant({
    modeCeiling: defaultAgentRunAuthorityCeilingForMode(input.mode),
    liveParentGrant: input.liveParentGrant,
    requestedAuthority: input.liveParentGrant,
    ...(input.projectCeiling === undefined ? {} : { projectCeiling: input.projectCeiling }),
    ...(input.globalCeiling === undefined ? {} : { globalCeiling: input.globalCeiling }),
  });
}

/**
 * Native is preferred only when the provider claims nativeChildAgents and
 * every required guarantee has evidence. Otherwise Octant-managed runs, and
 * the rejected reasons stay visible so a fallback is never silent.
 */
export function selectAgentRunExecutionKind(
  evidence: AgentRunNativeCapabilityEvidence,
): AgentRunExecutionSelection {
  const rejectedNativeReasons: string[] = [];
  if (evidence.claimedNativeSupport !== "supported") {
    rejectedNativeReasons.push(`nativeChildAgents-claimed-${evidence.claimedNativeSupport}`);
  }
  for (const key of NATIVE_EVIDENCE_KEYS) {
    if (!evidence[key]) rejectedNativeReasons.push(`missing-guarantee:${key}`);
  }
  if (rejectedNativeReasons.length === 0) {
    return {
      selectedExecutionKind: "provider-native",
      attemptedExecutionKind: "provider-native",
      capabilityDegradations: [],
      rejectedNativeReasons: [],
    };
  }
  return {
    selectedExecutionKind: "octant-managed",
    attemptedExecutionKind: "provider-native",
    nativeFallbackReason: rejectedNativeReasons.join(", "),
    capabilityDegradations: ["native-child-agents-unavailable"],
    rejectedNativeReasons,
  };
}

export function assertAgentRunSteerAllowed(run: AgentRun, expectedVersion: AggregateVersion): void {
  assertExpectedVersion(run, expectedVersion);
  if (run.lifecycleStatus !== "running" && run.lifecycleStatus !== "waiting") {
    reject("unsupported-transition", "Only a live child can be steered.");
  }
}

export function assertAgentRunRetryAllowed(run: AgentRun, expectedVersion: AggregateVersion): void {
  assertExpectedVersion(run, expectedVersion);
  if (run.lifecycleStatus !== "failed" && run.lifecycleStatus !== "interrupted") {
    reject("unsupported-transition", "Only a failed or interrupted child can be retried.");
  }
}

export function assertAgentRunResumeAllowed(
  run: AgentRun,
  expectedVersion: AggregateVersion,
): void {
  assertExpectedVersion(run, expectedVersion);
  if (run.lifecycleStatus === "waiting") return;
  if (run.lifecycleStatus !== "interrupted") {
    reject("unsupported-transition", "Only a waiting or resumable interrupted child can resume.");
  }
  if (run.recoveryReason === "restart-without-resumable-execution") {
    reject(
      "unsupported-transition",
      "This child has no resume evidence after restart; retry it instead.",
    );
  }
}
